import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { validateCaCertificate } from '../src/util/ca-certificates.js';

const read = (name) => fs.readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8');
const root = read('test-ca.pem');
test('CA validation accepts a current CA and rejects leaf, wrong subject and invalid dates', () => {
  const certificate = validateCaCertificate(root);
  assert.equal(certificate.ca, true);
  assert.throws(() => validateCaCertificate(read('test-server.pem')), /not a CA/);
  assert.throws(() => validateCaCertificate(root, { subjectPattern: /not-the-expected-CA/ }), /subject/);
  assert.throws(() => validateCaCertificate(root, { now: Date.parse(certificate.validFrom) - 1 }), /not yet valid/);
  assert.throws(() => validateCaCertificate(root, { now: Date.parse(certificate.validTo) }), /expired/);
});
test('CA validation rejects HTML, extra certificates, private keys and trailing content', () => {
  for (const value of ['<html>Error</html>', root + root, read('test-server.key'), root + 'unexpected']) {
    assert.throws(() => validateCaCertificate(value), /one PEM certificate/);
  }
});
