// Превращает записи из config/providers.json в рабочие объекты-провайдеры.
// Чтобы добавить новый тип провайдера, напишите файл в providers/ и впишите его сюда.
import { createGigaChatProvider } from './providers/gigachat.js';
import { createOpenAiProvider } from './providers/openai.js';

const FACTORIES = {
  openai: createOpenAiProvider,
  gigachat: createGigaChatProvider,
};

export function buildProviders(configs, env = process.env) {
  const seen = new Set();
  return configs.map((config) => {
    if (!config.id) throw new Error('В config/providers.json у провайдера не указан id.');
    if (seen.has(config.id)) throw new Error(`В config/providers.json два провайдера с одинаковым id «${config.id}».`);
    seen.add(config.id);

    const make = FACTORIES[config.type];
    if (!make) {
      throw new Error(`Провайдер «${config.id}»: неизвестный тип «${config.type}». Доступны: ${Object.keys(FACTORIES).join(', ')}.`);
    }
    return { config, impl: make(config, env) };
  });
}
