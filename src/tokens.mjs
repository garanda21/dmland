import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const TOKEN_PREFIX = 'enc:v1:';
const prefix = TOKEN_PREFIX;

// TOKEN_ENCRYPTION_KEY_FILE lets the key live outside the data volume (Docker secret, separate mount).
function loadKey() {
  if (!process.env.TOKEN_ENCRYPTION_KEY && process.env.TOKEN_ENCRYPTION_KEY_FILE) {
    try { process.env.TOKEN_ENCRYPTION_KEY = readFileSync(process.env.TOKEN_ENCRYPTION_KEY_FILE, 'utf8').trim(); }
    catch (e) { throw new Error(`Could not read TOKEN_ENCRYPTION_KEY_FILE (${process.env.TOKEN_ENCRYPTION_KEY_FILE}): ${e.code || e.message}`); }
  }
}

export function assertTokenKey() {
  loadKey();
  if (!/^[a-f0-9]{64}$/i.test(process.env.TOKEN_ENCRYPTION_KEY || '')) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be a 32-byte hex key');
  }
  return Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, 'hex');
}

export function sealToken(token) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', assertTokenKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return prefix + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

export function openToken(token) {
  if (!token.startsWith(prefix)) return token;
  const bytes = Buffer.from(token.slice(prefix.length), 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', assertTokenKey(), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
}
