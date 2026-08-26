/**
 * Envelope encryption for secrets stored in the database (provider API keys,
 * GitHub tokens). AES-256-GCM with a random IV per record; the master key comes
 * from the environment and never leaves the server.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { config } from '../config/env.js';
import { AppError, notConfigured } from './errors.js';

const VERSION = 'v1';

function masterKey() {
  const raw = config.encryptionKey;
  if (!raw) throw notConfigured('DIROX_ENCRYPTION_KEY');
  // Accept base64 32-byte keys directly; derive from any other string.
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length === 32) return decoded;
  return createHash('sha256').update(raw, 'utf8').digest();
}

export function encryptSecret(plaintext) {
  if (typeof plaintext !== 'string' || !plaintext) throw new AppError('Nothing to encrypt', { status: 400, code: 'bad_request' });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join('.');
}

export function decryptSecret(payload) {
  if (typeof payload !== 'string' || !payload.startsWith(`${VERSION}.`)) throw new AppError('Stored secret is malformed', { status: 500, code: 'internal_error' });
  const [, ivB64, tagB64, dataB64] = payload.split('.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new AppError('Stored secret could not be decrypted — the encryption key may have changed', { status: 500, code: 'internal_error' });
  }
}

/** Show enough of a secret to identify it without revealing it. */
export function maskSecret(value) {
  const text = String(value || '');
  if (text.length <= 8) return '••••••••';
  return `${text.slice(0, 4)}${'•'.repeat(8)}${text.slice(-4)}`;
}

export function fingerprint(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

/** Constant-time comparison for tokens and webhook signatures. */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function hmacSha256(secret, payload) {
  return createHmac('sha256', String(secret)).update(payload).digest('hex');
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export default { encryptSecret, decryptSecret, maskSecret, fingerprint, safeEqual, hmacSha256, randomToken };
