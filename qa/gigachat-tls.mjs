// No credentials or prompts. An HTTP response proves that TLS and hostname checks passed.
// Execute with the installed Node runtime against the installed provider and bundled CAs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const appDir = path.resolve(process.argv[2] || 'build/app');
const caFile = path.join(appDir, 'certs/russian_trusted_root_ca_pem.crt');
assert.equal((fs.readFileSync(caFile, 'utf8').match(/BEGIN CERTIFICATE/g) || []).length, 2, 'Packaged CA bundle missing');
const { createGigaChatProvider } = await import(pathToFileURL(path.join(appDir, 'src/pool/providers/gigachat.js')));
for (const oauthUrl of ['https://ngw.devices.sberbank.ru:9443/api/v2/oauth', 'https://api.giga.chat/v1/models']) {
  // Deliberately missing caFile: even old/customized profiles must use the packaged fallback.
  const provider = createGigaChatProvider({ baseUrl: 'https://api.giga.chat/v1', oauthUrl, timeoutSec: 20 }, { GIGACHAT_AUTH_KEY: 'prorab-tls-probe-invalid-key' });
  await assert.rejects(provider.listModels(), (error) => {
    assert.ok(error.status >= 400 && error.status < 500, `TLS probe did not reach HTTP: ${error.message}`);
    return true;
  });
  console.log('PASS: verified TLS using installed provider and CA bundle: ' + new URL(oauthUrl).host);
}
