import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException, ForbiddenException, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FirebaseAuthGuard } from '../firebase-auth.guard';

function makeExecutionContext(overrides: {
  headers?: Record<string, string>;
  handlerMeta?: Record<string, unknown>;
  classMeta?: Record<string, unknown>;
}): ExecutionContext {
  const request = {
    headers: overrides.headers ?? {},
    user: undefined as unknown,
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => 'handler' as any,
    getClass: () => 'class' as any,
    _request: request, // for assertions
  } as any;
}

function makeReflector(metaMap: Record<string, unknown> = {}) {
  return {
    getAllAndOverride: vi.fn((key: string) => metaMap[key] ?? undefined),
  } as unknown as Reflector;
}

function makeFirebaseAuthService() {
  return {
    verifyIdToken: vi.fn(),
    findOrCreateUser: vi.fn(),
  } as any;
}

function makeApiKeysService() {
  return {
    validateKey: vi.fn(),
  } as any;
}

describe('FirebaseAuthGuard', () => {
  let guard: FirebaseAuthGuard;
  let reflector: ReturnType<typeof makeReflector>;
  let firebaseAuthService: ReturnType<typeof makeFirebaseAuthService>;
  let apiKeysService: ReturnType<typeof makeApiKeysService>;

  beforeEach(() => {
    vi.clearAllMocks();
    reflector = makeReflector();
    firebaseAuthService = makeFirebaseAuthService();
    apiKeysService = makeApiKeysService();
    guard = new FirebaseAuthGuard(reflector, firebaseAuthService, apiKeysService);
  });

  it('should allow access for @Public endpoints', async () => {
    reflector = makeReflector({ isPublic: true });
    guard = new FirebaseAuthGuard(reflector, firebaseAuthService, apiKeysService);

    const ctx = makeExecutionContext({});
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  it('should throw when no Authorization header', async () => {
    const ctx = makeExecutionContext({ headers: {} });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  describe('API key auth', () => {
    it('should authenticate valid API key', async () => {
      const keyRecord = { id: 'key-1', userId: 'user-1', memoryBankIds: null };
      apiKeysService.validateKey.mockResolvedValue(keyRecord);

      const ctx = makeExecutionContext({
        headers: { authorization: 'Bearer bm_sk_abc123' },
      });
      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      expect((ctx as any)._request.user).toEqual({
        id: 'user-1',
        apiKeyId: 'key-1',
        scopes: ['read'],
        memoryBankIds: null,
      });
    });

    it('should parse memoryBankIds JSON', async () => {
      const keyRecord = {
        id: 'key-1',
        userId: 'user-1',
        memoryBankIds: '["bank-1","bank-2"]',
      };
      apiKeysService.validateKey.mockResolvedValue(keyRecord);

      const ctx = makeExecutionContext({
        headers: { authorization: 'Bearer bm_sk_test' },
      });
      await guard.canActivate(ctx);

      expect((ctx as any)._request.user.memoryBankIds).toEqual(['bank-1', 'bank-2']);
    });

    it('should reject invalid API key', async () => {
      apiKeysService.validateKey.mockResolvedValue(null);

      const ctx = makeExecutionContext({
        headers: { authorization: 'Bearer bm_sk_invalid' },
      });
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });

    it('should block API key on @RequiresJwt endpoints', async () => {
      reflector = makeReflector({ requiresJwt: true });
      guard = new FirebaseAuthGuard(reflector, firebaseAuthService, apiKeysService);

      apiKeysService.validateKey.mockResolvedValue({ id: 'k1', userId: 'u1' });

      const ctx = makeExecutionContext({
        headers: { authorization: 'Bearer bm_sk_test' },
      });
      await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('Firebase token auth', () => {
    it('should authenticate valid Firebase token', async () => {
      const decoded = { uid: 'fb-uid', email: 'test@example.com' };
      firebaseAuthService.verifyIdToken.mockResolvedValue(decoded);
      firebaseAuthService.findOrCreateUser.mockResolvedValue({
        user: { id: 'user-1', email: 'test@example.com' },
        needsRecoveryKey: false,
      });

      const ctx = makeExecutionContext({
        headers: { authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.firebase-token' },
      });
      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      expect((ctx as any)._request.user).toEqual({
        id: 'user-1',
        email: 'test@example.com',
      });
    });

    it('should throw when Firebase token is invalid', async () => {
      firebaseAuthService.verifyIdToken.mockRejectedValue(
        new UnauthorizedException('Invalid Firebase ID token'),
      );

      const ctx = makeExecutionContext({
        headers: { authorization: 'Bearer bad-token' },
      });
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });

    it('should throw when user sync fails', async () => {
      firebaseAuthService.verifyIdToken.mockResolvedValue({ uid: 'fb-uid' });
      firebaseAuthService.findOrCreateUser.mockResolvedValue({ user: null });

      const ctx = makeExecutionContext({
        headers: { authorization: 'Bearer valid-firebase-token' },
      });
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });
  });
});
