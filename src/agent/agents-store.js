// Загрузка агентов из папки agents/. Один агент — одна папка:
//   agents/<имя>/agent.json  — настройки (кто это, какие инструменты, какой режим);
//   agents/<имя>/SKILL.md    — инструкции для модели обычным текстом (Markdown).
// Чтобы создать нового агента, скопируйте папку существующего и поправьте оба файла.
import fs from 'node:fs';
import path from 'node:path';
import { readJson } from '../util/files.js';
import { TOOLS } from './tools.js';

export function loadAgents(dir) {
  if (!fs.existsSync(dir)) return [];
  const agents = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const configFile = path.join(dir, entry.name, 'agent.json');
    if (!fs.existsSync(configFile)) continue;

    const config = readJson(configFile);
    const skillFile = path.join(dir, entry.name, 'SKILL.md');
    const instructions = fs.existsSync(skillFile) ? stripFrontMatter(fs.readFileSync(skillFile, 'utf8')) : '';
    agents.push(normalizeAgent(entry.name, config, instructions));
  }
  return agents.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

/** Проверяет настройки агента и подставляет значения по умолчанию. */
export function normalizeAgent(id, config, instructions) {
  const where = `Агент «${id}»`;
  if (!config.name) throw new Error(`${where}: в agent.json не указано поле name.`);

  const tools = config.tools ?? [];
  for (const name of tools) {
    if (!TOOLS[name]) {
      throw new Error(`${where}: неизвестный инструмент «${name}». Доступны: ${Object.keys(TOOLS).join(', ')}.`);
    }
  }
  const mode = config.mode ?? 'manual';
  if (!['manual', 'auto'].includes(mode)) throw new Error(`${where}: режим (mode) — «manual» или «auto», а не «${mode}».`);

  return {
    id,
    name: config.name,
    description: config.description ?? '',
    instructions: instructions.trim(),
    tools,
    mode, // manual — любая запись просит разрешения; auto — запись файлов без вопросов (команды всегда с разрешением)
    maxSteps: config.maxSteps ?? 12,
    models: config.models ?? [], // пусто — все включённые провайдеры по порядку
    localOnly: Boolean(config.localOnly),
  };
}

/** SKILL.md может начинаться с блока «--- … ---» (формат Agent Skills). Для модели он не нужен. */
function stripFrontMatter(markdown) {
  const text = markdown.replace(/^\uFEFF/, '');
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  return end === -1 ? text : text.slice(end + 4);
}
