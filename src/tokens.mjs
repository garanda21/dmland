import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const prefix = 'enc:v1:';

export function assertTokenKey() {
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
