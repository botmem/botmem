/**
 * End-to-end encryption for the iMessage bridge tunnel.
 *
 * Protocol:
 *   1. Both sides generate ephemeral X25519 key pairs
 *   2. Exchange public keys during auth handshake
 *   3. Derive shared secret via ECDH
 *   4. Derive AES-256-GCM key via HKDF-SHA256
 *   5. Every frame encrypted with unique random IV
 *
 * Wire format (binary): [12-byte IV][ciphertext][16-byte auth tag]
 */

import {
  generateKeyPairSync,
  diffieHellman,
  hkdfSync,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  type KeyObject,
} from 'node:crypto';

// ── Key Exchange ────────────────────────────────────────────────────────────

export interface KeyPair {
  publicKey: KeyObject;
  privateKey: KeyObject;
}

/** Generate an ephemeral X25519 key pair for ECDH. */
export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return { publicKey, privateKey };
}

/** Export public key to raw 32-byte Buffer for wire transfer. */
export function exportPublicKey(key: KeyObject): Buffer {
  // DER format for X25519 public key: 12-byte header + 32-byte key
  const der = key.export({ type: 'spki', format: 'der' });
  return Buffer.from(der.subarray(12));
}

/** Import raw 32-byte public key from wire. */
export function importPublicKey(raw: Buffer): KeyObject {
  // Wrap raw 32 bytes in X25519 SPKI DER header
  const header = Buffer.from('302a300506032b656e032100', 'hex');
  const der = Buffer.concat([header, raw]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/** Derive a shared AES-256 key from local private + remote public via ECDH + HKDF. */
export function deriveSessionKey(localPrivate: KeyObject, remotePublic: KeyObject): Buffer {
  const sharedSecret = diffieHellman({
    privateKey: localPrivate,
    publicKey: remotePublic,
  });

  const salt = Buffer.from('botmem-imsg-tunnel-v1', 'utf-8');
  const info = Buffer.from('aes-256-gcm-session-key', 'utf-8');

  const derived = hkdfSync('sha256', sharedSecret, salt, info, 32);
  return Buffer.from(derived);
}

// ── Symmetric Encryption ────────────────────────────────────────────────────

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/** Encrypt plaintext with AES-256-GCM. Returns [IV (12) | ciphertext | tag (16)]. */
export function encrypt(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, encrypted, tag]);
}

/** Decrypt AES-256-GCM payload. Input: [IV (12) | ciphertext | tag (16)]. */
export function decrypt(key: Buffer, payload: Buffer): string {
  if (payload.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Encrypted payload too short');
  }

  const iv = payload.subarray(0, IV_LENGTH);
  const tag = payload.subarray(payload.length - TAG_LENGTH);
  const ciphertext = payload.subarray(IV_LENGTH, payload.length - TAG_LENGTH);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return decrypted.toString('utf-8');
}

// ── Convenience ─────────────────────────────────────────────────────────────

/** Encrypt a JSON-serializable object. */
export function encryptJson(key: Buffer, data: unknown): Buffer {
  return encrypt(key, JSON.stringify(data));
}

/** Decrypt a payload and parse as JSON. */
export function decryptJson<T = unknown>(key: Buffer, payload: Buffer): T {
  return JSON.parse(decrypt(key, payload)) as T;
}
