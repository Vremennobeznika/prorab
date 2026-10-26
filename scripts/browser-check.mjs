// Проверка страницы в НАСТОЯЩЕМ браузере (Chrome, Edge или Chromium): npm run browser-check
//
// Зачем: автотесты проверяют логику, но не то, как страница выглядит и ведёт себя в браузере.
// Этот скрипт открывает страницу на телефонных и компьютерных размерах, в светлой и тёмной теме,
// проходит сценарий «задача → разрешение → результат» настоящими кликами и ищет ошибки в консоли браузера.
//
// Один раз поставьте помощника (в папке проекта, без изменения package.json):
//   npm install --no-save puppeteer-core
// Браузер ищется сам. Если не нашёлся — укажите путь в переменной CHROME_PATH, например:
//   Windows PowerShell:  $env:CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe"; npm run browser-check
//   macOS / Linux:       CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run browser-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAgents } from '../src/agent/agents-store.js';
import { launch } from '../src/launch.js';
import { fromRoot } from '../src/util/paths.js';
import { demoScript } from './lib/demo-script.js';
import { startFakeModel } from './lib/fake-model.js';

let puppeteer;
try {
  puppeteer = (await import('puppeteer-core')).default;
} catch {
  console.error('Не найден puppeteer-core. Выполните один раз: npm install --no-save puppeteer-core');
  process.exit(1);
}

const candidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];
const executablePath = candidates.find((p) => p && fs.existsSync(p));
if (!executablePath) {
  console.error('Не нашёл Chrome или Edge. Укажите путь в переменной CHROME_PATH (см. подсказку в начале scripts/browser-check.mjs).');
  process.exit(1);
}

const results = [];
const problems = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? '✓' : '✕'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ── Прораб с «притворной» моделью и временными папками: ваши настоящие данные не затрагиваются
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prorab-browser-'));
const workspace = path.join(dir, 'workspace');
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace, 'привет.txt'), 'Первая строка.\n');
const fake = await startFakeModel(demoScript);
const running = await launch({
  settings: { workspace },
  providerConfigs: [{ id: 'demo', title: 'Демо-модель', type: 'openai', enabled: true, baseUrl: `http://127.0.0.1:${fake.port}/v1`, model: 'demo', privacy: 'local' }],
  agents: loadAgents(fromRoot('agents')),
  dataDir: path.join(dir, 'data'),
  port: 0,
});
const base = `http://127.0.0.1:${running.port}`;

const asRoot = process.getuid?.() === 0; // в контейнерах Chrome от root без этого флага не стартует
const browser = await puppeteer.launch({
  executablePath,
  headless: process.env.PRORAB_HEADLESS === 'shell' ? 'shell' : true,
  args: asRoot ? ['--no-sandbox', '--disable-dev-shm-usage'] : [],
});

async function open(viewport, scheme, label) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`[${label}] консоль: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[${label}] ошибка страницы: ${e.message}`));
  page.on('requestfailed', (r) => {
    // Поток событий закрывается самой страницей, когда запуск завершён, — это не ошибка.
    if (!(r.failure()?.errorText === 'net::ERR_ABORTED' && r.url().endsWith('/events'))) problems.push(`[${label}] запрос не удался: ${r.url()}`);
  });
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`[${label}] HTTP ${r.status()}: ${r.url()}`); });
  await page.setViewport(viewport);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
  await page.goto(`${base}/?token=${running.token}`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
}
const background = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const noScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

try {
  // ── телефон, светлая тема, живой сценарий
  const { context, page } = await open({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, 'light', 'телефон');
  check('заголовок вкладки «Прораб»', (await page.title()) === 'Прораб');
  check('все тексты подставлены (нет «сырых» ключей)', await page.evaluate(() => ![...document.querySelectorAll('[data-t]')].some((e) => /^[a-z]+\.[a-zA-Z]+$/.test(e.textContent.trim()))));
  check('светлая тема по умолчанию, когда этого просит система', (await background(page)) === 'rgb(255, 255, 255)');
  check('шрифт Inter загружен', await page.evaluate(() => [...document.fonts].some((f) => f.family.includes('Inter') && f.status === 'loaded')));
  check('телефон: нет горизонтальной прокрутки', await noScroll(page));
  check('телефон: вкладки прижаты к низу экрана', await page.evaluate(() => { const r = document.querySelector('#tabs').getBoundingClientRect(); return getComputedStyle(document.querySelector('#tabs')).position === 'fixed' && Math.abs(r.bottom - window.innerHeight) <= 1; }));
  const tiny = await page.evaluate(() => [...document.querySelectorAll('button:not([hidden]), select, textarea')].filter((e) => e.offsetParent).map((e) => Math.min(e.getBoundingClientRect().height, e.getBoundingClientRect().width)).filter((s) => s < 44).length);
  check('кнопки и поля не меньше 44 px (удобно нажимать пальцем)', tiny === 0, tiny ? `мелких элементов: ${tiny}` : '');

  await page.select('#agent-select', 'file-helper');
  await page.type('#task', 'допиши строку в привет.txt');
  await page.click('#run-form button[type=submit]');
  await page.waitForSelector('.approval', { timeout: 10000 });
  check('после клика «Запустить» появилась карточка разрешения', true, await page.$eval('.approval strong', (e) => e.textContent));
  check('ход работы виден в журнале', (await page.$$eval('#log .ev', (n) => n.length)) >= 5);
  const [allow] = await page.$$('.approval .btn');
  await allow.click();
  await page.waitForFunction(() => document.querySelector('#run-status')?.textContent.includes('Готово'), { timeout: 10000 });
  check('после «Разрешить» запуск завершён', !(await page.$('.approval')));
  check('файл изменён', fs.readFileSync(path.join(workspace, 'привет.txt'), 'utf8').endsWith('Эту строку дописал демонстрационный агент.\n'));

  await page.click('#theme-toggle');
  check('кнопка темы включает тёмную тему (#121212)', (await background(page)) === 'rgb(18, 18, 18)');
  await page.reload({ waitUntil: 'networkidle0' });
  check('выбранная тема запоминается после перезагрузки', (await background(page)) === 'rgb(18, 18, 18)');
  await context.close();

  // ── разные ширины экрана
  for (const width of [320, 360, 414, 768, 1024, 1280, 1920]) {
    const o = await open({ width, height: 800 }, 'light', `ширина ${width}`);
    check(`ширина ${width} px: нет горизонтальной прокрутки`, await noScroll(o.page));
    await o.context.close();
  }

  // ── компьютер, тёмная тема по системной
  const desktop = await open({ width: 1280, height: 800 }, 'dark', 'компьютер');
  check('компьютер: тёмная тема подхватывается из системы', (await background(desktop.page)) === 'rgb(18, 18, 18)');
  check('компьютер: вкладки сверху', (await desktop.page.evaluate(() => getComputedStyle(document.querySelector('#tabs')).position)) !== 'fixed');
  await desktop.context.close();
} catch (err) {
  console.error('\nСбой проверки:', err.message);
  results.push(false);
} finally {
  console.log(`\nЗамечаний в консоли браузера: ${problems.length}`);
  for (const p of problems) console.log(`  ${p}`);
  const failed = results.filter((r) => !r).length;
  console.log(`Итого: ${results.length - failed} из ${results.length} проверок пройдено.`);
  await browser.close();
  running.app.stopAll();
  running.server.closeAllConnections?.();
  running.server.close();
  await fake.close();
  process.exit(failed || problems.length ? 1 : 0);
}
