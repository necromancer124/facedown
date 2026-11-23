// Export and import: move a vault to another computer.
//
// A vault's key is tied to this computer and Windows account, so an export
// re-encrypts every secret with a key made from a passphrase the user chooses
// (scrypt). Only the user can type that passphrase: export and import are CLI
// commands that ask in a window or terminal, never MCP tools.
//
// File format (JSON):
//   { "format": "facedown-export", "version": 1,
//     "kdf": { "name": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": "<b64>" },
//     "nonce": "<b64>", "data": "<b64 ciphertext + tag>" }
// Everything about the secrets, names included, is inside "data".

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

export const EXPORT_FORMAT = 'facedown-export';
export const MIN_PASSPHRASE_LENGTH = 12;
const VERSION = 1;
const AAD = Buffer.from('facedown-export-v1', 'utf8');
const DEFAULT_KDF = { name: 'scrypt', N: 2 ** 17, r: 8, p: 1 };

function deriveKey(passphrase, { N, r, p, salt }) {
  // N=2^17, r=8 needs 128 MiB; allow up to 2^20 for files made with stronger settings.
  return scryptSync(String(passphrase).normalize('NFC'), salt, 32, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 });
}

/** entries: [{ name, description, allow, value }]. Returns the export file text. */
export function encryptExport(entries, passphrase, kdf = DEFAULT_KDF) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`the passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
  const salt = randomBytes(16);
  const key = deriveKey(passphrase, { ...kdf, salt });
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(AAD);
  const plain = Buffer.from(JSON.stringify({ entries }), 'utf8');
  const data = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  plain.fill(0);
  return (
    JSON.stringify(
      {
        format: EXPORT_FORMAT,
        version: VERSION,
        note: 'facedown vault export. Opens only with the passphrase chosen when it was made. Keep it safe.',
        kdf: { name: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p, salt: salt.toString('base64') },
        nonce: nonce.toString('base64'),
        data: data.toString('base64'),
      },
      null,
      2
    ) + '\n'
  );
}

/** Returns [{ name, description, allow, value }]. Throws on a wrong passphrase. */
export function decryptExport(text, passphrase) {
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    throw new Error('this is not a facedown export file');
  }
  if (file?.format !== EXPORT_FORMAT) throw new Error('this is not a facedown export file');
  if (file.version !== VERSION) throw new Error(`unsupported export version ${file.version}; update facedown`);
  const { kdf } = file;
  // The settings come from the file, so bound them (a huge N would hang or
  // exhaust memory).
  const okKdf =
    kdf?.name === 'scrypt' &&
    Number.isInteger(kdf.N) && kdf.N >= 2 ** 14 && kdf.N <= 2 ** 20 && (kdf.N & (kdf.N - 1)) === 0 &&
    kdf.r === 8 && Number.isInteger(kdf.p) && kdf.p >= 1 && kdf.p <= 4 && typeof kdf.salt === 'string';
  if (!okKdf || typeof file.nonce !== 'string' || typeof file.data !== 'string') {
    throw new Error('the export file is damaged');
  }
  const key = deriveKey(passphrase, { ...kdf, salt: Buffer.from(kdf.salt, 'base64') });
  const raw = Buffer.from(file.data, 'base64');
  let plain;
  try {
    if (raw.length < 16) throw new Error('short');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.nonce, 'base64'));
    decipher.setAAD(AAD);
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    plain = Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]);
  } catch {
    throw new Error('wrong passphrase, or the export file is damaged');
  }
  const { entries } = JSON.parse(plain.toString('utf8'));
  plain.fill(0);
  if (!Array.isArray(entries)) throw new Error('the export file is damaged');
  return entries;
}
