import type { TokenSecurityPort } from '../identity/ports.js';
import type { EmailLookupHashPort } from './ports.js';

export class IdentityEmailLookupHasher implements EmailLookupHashPort {
  constructor(private readonly tokens: Pick<TokenSecurityPort, 'hash'>) {}

  hashCanonicalEmail(email: string): Promise<string> {
    return this.tokens.hash(`email:${email}`);
  }
}
