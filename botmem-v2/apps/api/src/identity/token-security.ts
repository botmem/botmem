import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { CredentialKind } from './domain.js';
import type { TokenSecurityPort } from './ports.js';

const TOKEN_BYTES = 32;

export class NodeTokenSecurity implements TokenSecurityPort {
  constructor(private readonly pepper: Uint8Array) {
    if (pepper.byteLength !== 32) {
      throw new Error('credential token pepper must be exactly 32 bytes');
    }
  }

  async issue(kind: CredentialKind): Promise<{
    readonly value: string;
    readonly hashHex: string;
    readonly prefix: string;
  }> {
    const random = randomBytes(TOKEN_BYTES).toString('base64url');
    const marker = kind === 'browser_session' ? 'bms_v2.' : 'bmp_v2.';
    const value = `${marker}${random}`;
    return {
      value,
      hashHex: await this.hash(value),
      prefix: random.slice(0, 12),
    };
  }

  async issueLoginToken(): Promise<{ readonly value: string; readonly hashHex: string }> {
    const value = `bml_v2.${randomBytes(TOKEN_BYTES).toString('base64url')}`;
    return { value, hashHex: await this.hash(value) };
  }

  async hash(value: string): Promise<string> {
    return createHmac('sha256', this.pepper).update(value, 'utf8').digest('hex');
  }

  uuid(): string {
    return randomUUID();
  }
}
