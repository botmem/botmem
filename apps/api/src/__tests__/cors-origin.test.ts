import { describe, it, expect } from 'vitest';
import { createCorsOriginChecker } from '../cors.util';

function check(
  checker: ReturnType<typeof createCorsOriginChecker>,
  origin: string | undefined,
): Promise<{ err: Error | null; allow?: boolean }> {
  return new Promise((resolve) => {
    checker(origin, (err, allow) => resolve({ err, allow }));
  });
}

describe('createCorsOriginChecker', () => {
  it('allows requests with no origin (curl/same-origin)', async () => {
    const checker = createCorsOriginChecker('http://localhost:3000');
    const { err, allow } = await check(checker, undefined);
    expect(err).toBeNull();
    expect(allow).toBe(true);
  });

  it('allows origin matching single frontendUrl', async () => {
    const checker = createCorsOriginChecker('http://localhost:3000');
    const { err, allow } = await check(checker, 'http://localhost:3000');
    expect(err).toBeNull();
    expect(allow).toBe(true);
  });

  it('allows origin matching one of comma-separated URLs', async () => {
    const checker = createCorsOriginChecker('http://localhost:3000,https://botmem.xyz');
    const { err, allow } = await check(checker, 'https://botmem.xyz');
    expect(err).toBeNull();
    expect(allow).toBe(true);
  });

  it('rejects origin NOT in allowed list', async () => {
    const checker = createCorsOriginChecker('http://localhost:3000');
    const { err, allow } = await check(checker, 'https://evil.com');
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('https://evil.com');
    expect(allow).toBe(false);
  });

  it('trims whitespace in comma-separated origins', async () => {
    const checker = createCorsOriginChecker('http://localhost:3000 , https://botmem.xyz ');
    const { err, allow } = await check(checker, 'https://botmem.xyz');
    expect(err).toBeNull();
    expect(allow).toBe(true);
  });
});
