// Inputs are downloaded over verified HTTPS from the URLs in Sber's documentation.
import fs from 'node:fs';
import path from 'node:path';
import { validateCaCertificate } from '../src/util/ca-certificates.js';

const [rootFile, subFile, outputFile] = process.argv.slice(2);
if (!rootFile || !subFile || !outputFile) throw new Error('Usage: prepare-gigachat-certs.mjs root.crt sub.crt bundle.crt');
const root = validateCaCertificate(fs.readFileSync(rootFile, 'utf8'), { subjectPattern: /(?:^|\n)CN=Russian Trusted Root CA(?:\n|$)/ });
const sub = validateCaCertificate(fs.readFileSync(subFile, 'utf8'), { subjectPattern: /(?:^|\n)CN=Russian Trusted Sub CA(?:\n|$)/ });
if (!root.verify(root.publicKey) || !sub.checkIssued(root) || !sub.verify(root.publicKey)) throw new Error('Russian CA chain verification failed');
fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, root.toString() + '\n' + sub.toString());
console.log(JSON.stringify({ certificates: [root, sub].map((c) => ({ subject: c.subject, fingerprint256: c.fingerprint256, validTo: c.validTo })) }));
