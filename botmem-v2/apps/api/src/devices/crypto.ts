import type { DigestPort, SecretGeneratorPort, SignatureVerifierPort } from './ports.js';

export class WebCryptoDeviceSecurity
  implements DigestPort, SecretGeneratorPort, SignatureVerifierPort
{
  bytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 1 || length > 1024) {
      throw new RangeError('random byte length must be between 1 and 1024');
    }
    return globalThis.crypto.getRandomValues(new Uint8Array(length));
  }

  uuid(): string {
    return globalThis.crypto.randomUUID();
  }

  async sha256(value: Uint8Array): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', arrayBuffer(value));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async verifyEd25519(input: {
    publicKeyBase64Url: string;
    message: Uint8Array;
    signatureBase64Url: string;
  }): Promise<boolean> {
    const publicKey = decodeBase64Url(input.publicKeyBase64Url);
    const signature = decodeBase64Url(input.signatureBase64Url);
    if (publicKey.byteLength !== 32 || signature.byteLength !== 64) return false;
    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      arrayBuffer(publicKey),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return globalThis.crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      arrayBuffer(signature),
      arrayBuffer(input.message),
    );
  }
}

export function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new TypeError('value is not base64url');
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}
