// Показывает имена моделей GigaChat, доступные вашему ключу: npm run gigachat-models
// Имя нужно вписать в поле model провайдера «gigachat» в config/providers.json.
import { buildProviders } from '../src/pool/registry.js';
import { readJson } from '../src/util/files.js';
import { fromRoot } from '../src/util/paths.js';

try {
  process.loadEnvFile(fromRoot('.env'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

const config = readJson(fromRoot('config', 'providers.json')).providers.find((p) => p.type === 'gigachat');
if (!config) {
  console.error('В config/providers.json нет провайдера типа gigachat.');
  process.exit(1);
}

const [{ impl }] = buildProviders([config]);
const ready = impl.check();
if (!ready.ok) {
  console.error(`GigaChat не готов: ${ready.reason}`);
  process.exit(1);
}

try {
  const ids = await impl.listModels();
  console.log(ids.length ? ids.join('\n') : '(список пуст)');
} catch (err) {
  console.error(`Не удалось получить список: ${err.message}`);
  process.exit(1);
}
