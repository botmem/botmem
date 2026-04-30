import { createHash } from 'crypto';

export function rawEventSourceHash(accountId: string, connectorType: string, sourceId: string) {
  return createHash('sha256').update(`${accountId}:${connectorType}:${sourceId}`).digest('hex');
}
