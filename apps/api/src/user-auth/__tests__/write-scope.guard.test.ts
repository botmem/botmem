import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WriteScopeGuard } from '../write-scope.guard';

function makeContext(overrides: {
  method?: string;
  user?: Record<string, unknown> | null;
  meta?: Record<string, unknown>;
}): ExecutionContext {
  const request = {
    method: overrides.method ?? 'GET',
    user: overrides.user ?? undefined,
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => 'handler' as any,
    getClass: () => 'class' as any,
  } as any;
}

function makeReflector(metaMap: Record<string, unknown> = {}) {
  return {
    getAllAndOverride: vi.fn((key: string) => metaMap[key] ?? undefined),
  } as unknown as Reflector;
}

describe('WriteScopeGuard', () => {
  let guard: WriteScopeGuard;
  let reflector: ReturnType<typeof makeReflector>;

  beforeEach(() => {
    reflector = makeReflector();
    guard = new WriteScopeGuard(reflector);
  });

  it('should allow @Public endpoints', () => {
    reflector = makeReflector({ isPublic: true });
    guard = new WriteScopeGuard(reflector);

    const ctx = makeContext({ method: 'POST', user: { apiKeyId: 'k1', scopes: ['read'] } });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should allow non-API key users for any method', () => {
    const ctx = makeContext({ method: 'POST', user: { id: 'user-1' } });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should allow GET requests for API keys', () => {
    const ctx = makeContext({ method: 'GET', user: { apiKeyId: 'k1', scopes: ['read'] } });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should block POST for API keys without write scope', () => {
    const ctx = makeContext({ method: 'POST', user: { apiKeyId: 'k1', scopes: ['read'] } });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('should block PUT for API keys without write scope', () => {
    const ctx = makeContext({ method: 'PUT', user: { apiKeyId: 'k1', scopes: ['read'] } });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('should block PATCH for API keys without write scope', () => {
    const ctx = makeContext({ method: 'PATCH', user: { apiKeyId: 'k1', scopes: ['read'] } });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('should block DELETE for API keys without write scope', () => {
    const ctx = makeContext({ method: 'DELETE', user: { apiKeyId: 'k1', scopes: ['read'] } });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('should allow POST for API keys with write scope', () => {
    const ctx = makeContext({
      method: 'POST',
      user: { apiKeyId: 'k1', scopes: ['read', 'write'] },
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should allow @ReadOnly POST endpoints for API keys', () => {
    reflector = makeReflector({ isReadOnly: true });
    guard = new WriteScopeGuard(reflector);

    const ctx = makeContext({ method: 'POST', user: { apiKeyId: 'k1', scopes: ['read'] } });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should handle missing scopes array gracefully', () => {
    const ctx = makeContext({ method: 'POST', user: { apiKeyId: 'k1' } });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('should allow when user is null/undefined (pre-auth)', () => {
    const ctx = makeContext({ method: 'POST', user: null });
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
