import { X509Certificate } from 'node:crypto';

// Build-time validation. Public CA certificates only; never accept a private key.
export function validateCaCertificate(pem, { subjectPattern, now = Date.now() } = {}) {
  const blocks = String(pem).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  if (blocks.length !== 1 || String(pem).replace(blocks[0], '').trim()) {
    throw new Error('Expected one PEM certificate without other data');
  }
  const certificate = new X509Certificate(blocks[0]);
  if (!certificate.ca) throw new Error('Certificate is not a CA');
  if (!(Date.parse(certificate.validFrom) <= now && now < Date.parse(certificate.validTo))) {
    throw new Error('CA certificate is expired or not yet valid');
  }
  if (subjectPattern && !subjectPattern.test(certificate.subject)) throw new Error('Unexpected CA subject');
  return certificate;
}
