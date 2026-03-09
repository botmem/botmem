/**
 * Thrown when a user's encryption key is not available in server memory.
 * The user must log in again to derive and cache their key.
 * BullMQ processors should retry jobs that throw this error with exponential backoff.
 */
export class EncryptionKeyMissingError extends Error {
  constructor(userId: string) {
    super(`Encryption key not available for user ${userId}. User must log in.`);
    this.name = 'EncryptionKeyMissingError';
  }
}
