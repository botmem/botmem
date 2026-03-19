import { describe, it, expect } from 'vitest';
import { keyToMnemonic, mnemonicToKey, resolveRecoveryKey, isMnemonic } from '../mnemonic';

describe('mnemonic', () => {
  // A fixed 32-byte key for deterministic tests
  const testKey = Buffer.from(new Uint8Array(32).fill(0xab)).toString('base64');

  it('keyToMnemonic returns a 24-word phrase', () => {
    const phrase = keyToMnemonic(testKey);
    expect(phrase.split(' ')).toHaveLength(24);
  });

  it('mnemonicToKey round-trips with keyToMnemonic', () => {
    const phrase = keyToMnemonic(testKey);
    const recovered = mnemonicToKey(phrase);
    expect(recovered).toBe(testKey);
  });

  it('resolveRecoveryKey returns base64 key as-is', () => {
    expect(resolveRecoveryKey(testKey)).toBe(testKey);
  });

  it('resolveRecoveryKey converts mnemonic phrase to base64', () => {
    const phrase = keyToMnemonic(testKey);
    expect(resolveRecoveryKey(phrase)).toBe(testKey);
  });

  it('resolveRecoveryKey trims whitespace', () => {
    expect(resolveRecoveryKey(`  ${testKey}  `)).toBe(testKey);
  });

  it('isMnemonic returns true for valid phrase', () => {
    const phrase = keyToMnemonic(testKey);
    expect(isMnemonic(phrase)).toBe(true);
  });

  it('isMnemonic returns false for base64 key', () => {
    expect(isMnemonic(testKey)).toBe(false);
  });

  it('isMnemonic returns false for random words', () => {
    expect(isMnemonic('hello world foo bar')).toBe(false);
  });
});
