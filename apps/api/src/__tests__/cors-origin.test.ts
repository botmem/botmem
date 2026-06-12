import { describe, it, expect } from 'vitest';
import {
  createCorsOriginChecker,
  createCorsOptionsDelegate,
  isCorsOriginAllowed,
} from '../cors.util';

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

  it('allows requests with null origin', () => {
    expect(
      isCorsOriginAllowed({
        frontendUrl: 'https://botmem.xyz',
        origin: 'null',
        path: '/mcp',
        nodeEnv: 'production',
      }),
    ).toBe(true);
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

  it('allows only configured or canonical HTTPS origins for MCP and well-known metadata routes', () => {
    expect(
      isCorsOriginAllowed({
        frontendUrl: 'https://botmem.xyz',
        origin: 'https://botmem.xyz',
        path: '/mcp',
        nodeEnv: 'production',
      }),
    ).toBe(true);
    expect(
      isCorsOriginAllowed({
        frontendUrl: 'https://botmem.xyz',
        origin: 'https://api.botmem.xyz',
        path: '/mcp/',
        nodeEnv: 'production',
      }),
    ).toBe(true);
    expect(
      isCorsOriginAllowed({
        frontendUrl: 'https://botmem.xyz',
        origin: 'https://evil.com',
        path: '/.well-known/oauth-protected-resource',
        nodeEnv: 'production',
      }),
    ).toBe(false);
  });

  it('does not allow arbitrary HTTPS origins for normal API routes', () => {
    expect(
      isCorsOriginAllowed({
        frontendUrl: 'https://botmem.xyz',
        origin: 'https://claude.ai',
        path: '/api/version',
        nodeEnv: 'production',
      }),
    ).toBe(false);
  });

  it('allows localhost origins for MCP routes outside production', () => {
    expect(
      isCorsOriginAllowed({
        frontendUrl: 'http://localhost:12412',
        origin: 'http://localhost:5173',
        path: '/mcp',
        nodeEnv: 'test',
      }),
    ).toBe(true);
  });

  it('builds request-aware CORS options that echo allowed MCP origins', async () => {
    const delegate = createCorsOptionsDelegate('https://botmem.xyz');
    const options = await new Promise<{ err: Error | null; origin?: boolean }>((resolve) => {
      delegate(
        {
          headers: { origin: 'https://api.botmem.xyz' },
          path: '/mcp',
          originalUrl: '/mcp',
          url: '/mcp',
        } as never,
        (err, opts) => resolve({ err, origin: opts?.origin as boolean | undefined }),
      );
    });

    expect(options.err).toBeNull();
    expect(options.origin).toBe(true);
  });

  it('does not turn CORS rejections into delegate errors', async () => {
    const delegate = createCorsOptionsDelegate('https://botmem.xyz');
    const options = await new Promise<{ err: Error | null; origin?: boolean }>((resolve) => {
      delegate(
        {
          headers: { origin: 'https://evil.com' },
          path: '/mcp',
          originalUrl: '/mcp',
          url: '/mcp',
        } as never,
        (err, opts) => resolve({ err, origin: opts?.origin as boolean | undefined }),
      );
    });

    expect(options.err).toBeNull();
    expect(options.origin).toBe(false);
  });

  it('trims whitespace in comma-separated origins', async () => {
    const checker = createCorsOriginChecker('http://localhost:3000 , https://botmem.xyz ');
    const { err, allow } = await check(checker, 'https://botmem.xyz');
    expect(err).toBeNull();
    expect(allow).toBe(true);
  });
});
