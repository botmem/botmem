import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { createHash } from 'crypto';

// Mock ioredis
const redisStore = new Map<string, string>();
const redisMock = {
  get: vi.fn((key: string) => Promise.resolve(redisStore.get(key) ?? null)),
  set: vi.fn((key: string, value: string) => {
    redisStore.set(key, value);
    return Promise.resolve('OK');
  }),
  del: vi.fn((key: string) => {
    redisStore.delete(key);
    return Promise.resolve(1);
  }),
  connect: vi.fn(() => Promise.resolve()),
  disconnect: vi.fn(),
};

vi.mock('ioredis', () => ({
  default: vi.fn(() => redisMock),
}));

vi.mock('bcrypt', () => ({
  compare: vi.fn(),
}));

import { CliAuthService } from '../cli-auth.service';
import * as bcrypt from 'bcrypt';

function makeConfig() {
  return {
    redisUrl: 'redis://localhost:6379',
    frontendUrl: 'http://localhost:12412',
  } as any;
}

function makeAuthService() {
  return {
    generateTokensForUser: vi.fn().mockResolvedValue({
      accessToken: 'access-tok',
      refreshToken: 'refresh-tok',
    }),
  } as any;
}

function makeUsersService() {
  return {
    findByEmail: vi.fn(),
    findById: vi.fn(),
  } as any;
}

function makeUserKeyService() {
  return {
    getDek: vi.fn(),
    storeDek: vi.fn(),
  } as any;
}

describe('CliAuthService', () => {
  let service: CliAuthService;
  let config: ReturnType<typeof makeConfig>;
  let authService: ReturnType<typeof makeAuthService>;
  let usersService: ReturnType<typeof makeUsersService>;
  let userKeyService: ReturnType<typeof makeUserKeyService>;

  beforeEach(() => {
    vi.clearAllMocks();
    redisStore.clear();

    config = makeConfig();
    authService = makeAuthService();
    usersService = makeUsersService();
    userKeyService = makeUserKeyService();

    service = new CliAuthService(config, authService, usersService, userKeyService);
  });

  describe('createSession', () => {
    it('should create a session and return sessionId + loginUrl', async () => {
      const result = await service.createSession({
        codeChallenge: 'challenge123',
        codeChallengeMethod: 'S256',
        redirectUri: 'http://localhost:9876/callback',
        state: 'my-state',
      });

      expect(result.sessionId).toBeDefined();
      expect(result.loginUrl).toContain('http://localhost:12412/cli-login');
      expect(result.loginUrl).toContain('session_id=');
      expect(redisMock.set).toHaveBeenCalledWith(
        expect.stringContaining('cli_auth:'),
        expect.any(String),
        'EX',
        600,
      );
    });

    it('should reject non-localhost redirect URIs', async () => {
      await expect(
        service.createSession({
          codeChallenge: 'challenge123',
          codeChallengeMethod: 'S256',
          redirectUri: 'https://evil.com/callback',
          state: 'state',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should allow 127.0.0.1 redirect URIs', async () => {
      const result = await service.createSession({
        codeChallenge: 'ch',
        codeChallengeMethod: 'S256',
        redirectUri: 'http://127.0.0.1:9999/cb',
        state: 's',
      });
      expect(result.sessionId).toBeDefined();
    });
  });

  describe('approve', () => {
    const sessionData = {
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
      redirectUri: 'http://localhost:9876/callback',
      state: 'state-1',
    };

    beforeEach(() => {
      redisStore.set('cli_auth:sess-1', JSON.stringify(sessionData));
    });

    it('should approve valid credentials and return redirect with code', async () => {
      const user = {
        id: 'user-1',
        email: 'test@example.com',
        passwordHash: '$2b$12$hashhere',
        recoveryKeyHash: 'rkhash',
      };
      usersService.findByEmail.mockResolvedValue(user);
      (bcrypt.compare as any).mockResolvedValue(true);
      userKeyService.getDek.mockResolvedValue(Buffer.from('dek'));

      const result = await service.approve({
        sessionId: 'sess-1',
        email: 'test@example.com',
        password: 'password123',
      });

      expect(result.redirectUri).toContain('http://localhost:9876/callback');
      expect(result.redirectUri).toContain('code=');
      expect(result.redirectUri).toContain('state=state-1');
      // Session should be cleaned up
      expect(redisMock.del).toHaveBeenCalledWith('cli_auth:sess-1');
    });

    it('should throw on invalid/expired session', async () => {
      await expect(
        service.approve({
          sessionId: 'non-existent',
          email: 'test@example.com',
          password: 'pass',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw on invalid credentials (user not found)', async () => {
      usersService.findByEmail.mockResolvedValue(null);

      await expect(
        service.approve({
          sessionId: 'sess-1',
          email: 'wrong@example.com',
          password: 'pass',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw on wrong password', async () => {
      usersService.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'test@example.com',
        passwordHash: '$2b$12$hash',
      });
      (bcrypt.compare as any).mockResolvedValue(false);

      await expect(
        service.approve({
          sessionId: 'sess-1',
          email: 'test@example.com',
          password: 'wrong',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw on firebase social login accounts', async () => {
      usersService.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'test@example.com',
        passwordHash: 'firebase:uid123',
      });

      await expect(
        service.approve({
          sessionId: 'sess-1',
          email: 'test@example.com',
          password: 'pass',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should require recovery key when DEK not cached', async () => {
      usersService.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'test@example.com',
        passwordHash: '$2b$12$hash',
        recoveryKeyHash: 'rkhash',
      });
      (bcrypt.compare as any).mockResolvedValue(true);
      userKeyService.getDek.mockResolvedValue(null);

      await expect(
        service.approve({
          sessionId: 'sess-1',
          email: 'test@example.com',
          password: 'pass',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should accept valid recovery key and store DEK', async () => {
      const recoveryKey = Buffer.from('a'.repeat(32)).toString('base64');
      const recoveryKeyHash = createHash('sha256').update(recoveryKey).digest('hex');
      usersService.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'test@example.com',
        passwordHash: '$2b$12$hash',
        recoveryKeyHash,
      });
      (bcrypt.compare as any).mockResolvedValue(true);
      userKeyService.getDek.mockResolvedValue(null);

      const result = await service.approve({
        sessionId: 'sess-1',
        email: 'test@example.com',
        password: 'pass',
        recoveryKey,
      });

      expect(userKeyService.storeDek).toHaveBeenCalledWith('u1', expect.any(Buffer));
      expect(result.redirectUri).toContain('code=');
    });

    it('should reject invalid recovery key', async () => {
      usersService.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'test@example.com',
        passwordHash: '$2b$12$hash',
        recoveryKeyHash: 'correct-hash',
      });
      (bcrypt.compare as any).mockResolvedValue(true);
      userKeyService.getDek.mockResolvedValue(null);

      await expect(
        service.approve({
          sessionId: 'sess-1',
          email: 'test@example.com',
          password: 'pass',
          recoveryKey: 'wrong-key',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('approveWithToken', () => {
    const sessionData = {
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
      redirectUri: 'http://localhost:9876/callback',
      state: 'state-1',
    };

    beforeEach(() => {
      redisStore.set('cli_auth:sess-1', JSON.stringify(sessionData));
    });

    it('should approve with existing JWT session when DEK is cached', async () => {
      userKeyService.getDek.mockResolvedValue(Buffer.from('dek'));

      const result = await service.approveWithToken({
        sessionId: 'sess-1',
        userId: 'user-1',
        email: 'test@example.com',
      });

      expect(result.redirectUri).toContain('code=');
      expect(result.redirectUri).toContain('state=state-1');
    });

    it('should throw on invalid session', async () => {
      await expect(
        service.approveWithToken({
          sessionId: 'bad',
          userId: 'u1',
          email: 'test@example.com',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should require recovery key when DEK not cached', async () => {
      userKeyService.getDek.mockResolvedValue(null);

      await expect(
        service.approveWithToken({
          sessionId: 'sess-1',
          userId: 'u1',
          email: 'test@example.com',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should accept valid recovery key and store DEK', async () => {
      const recoveryKey = Buffer.from('b'.repeat(32)).toString('base64');
      const recoveryKeyHash = createHash('sha256').update(recoveryKey).digest('hex');
      userKeyService.getDek.mockResolvedValue(null);
      usersService.findById.mockResolvedValue({
        id: 'u1',
        recoveryKeyHash,
      });

      const result = await service.approveWithToken({
        sessionId: 'sess-1',
        userId: 'u1',
        email: 'test@example.com',
        recoveryKey,
      });

      expect(userKeyService.storeDek).toHaveBeenCalledWith('u1', expect.any(Buffer));
      expect(result.redirectUri).toContain('code=');
    });
  });

  describe('exchangeCode', () => {
    it('should exchange valid code with correct PKCE verifier', async () => {
      // Set up a valid code in redis
      const codeVerifier = 'test-verifier-string-long-enough';
      const codeChallenge = createHash('sha256')
        .update(codeVerifier)
        .digest()
        .toString('base64url');

      const codeData = {
        userId: 'user-1',
        email: 'test@example.com',
        codeChallenge,
        codeChallengeMethod: 'S256',
        redirectUri: 'http://localhost:9876/callback',
      };
      redisStore.set('cli_code:valid-code', JSON.stringify(codeData));
      usersService.findById.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
      });

      const result = await service.exchangeCode({
        code: 'valid-code',
        codeVerifier,
        redirectUri: 'http://localhost:9876/callback',
      });

      expect(result.accessToken).toBe('access-tok');
      expect(result.refreshToken).toBe('refresh-tok');
      expect(result.user).toEqual({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
      });
      // Code should be consumed (deleted)
      expect(redisMock.del).toHaveBeenCalledWith('cli_code:valid-code');
    });

    it('should throw on invalid/expired code', async () => {
      await expect(
        service.exchangeCode({
          code: 'non-existent',
          codeVerifier: 'verifier',
          redirectUri: 'http://localhost:9876/callback',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw on redirect URI mismatch', async () => {
      const codeData = {
        userId: 'user-1',
        email: 'test@example.com',
        codeChallenge: 'ch',
        codeChallengeMethod: 'S256',
        redirectUri: 'http://localhost:9876/callback',
      };
      redisStore.set('cli_code:code-1', JSON.stringify(codeData));

      await expect(
        service.exchangeCode({
          code: 'code-1',
          codeVerifier: 'verifier',
          redirectUri: 'http://localhost:9999/wrong',
        }),
      ).rejects.toThrow('Redirect URI mismatch');
    });

    it('should throw on invalid PKCE verifier', async () => {
      const codeData = {
        userId: 'user-1',
        email: 'test@example.com',
        codeChallenge: 'correct-challenge',
        codeChallengeMethod: 'S256',
        redirectUri: 'http://localhost:9876/callback',
      };
      redisStore.set('cli_code:code-2', JSON.stringify(codeData));

      await expect(
        service.exchangeCode({
          code: 'code-2',
          codeVerifier: 'wrong-verifier',
          redirectUri: 'http://localhost:9876/callback',
        }),
      ).rejects.toThrow('PKCE validation failed');
    });

    it('should return empty name when user not found', async () => {
      const codeVerifier = 'test-verifier-for-empty-name';
      const codeChallenge = createHash('sha256')
        .update(codeVerifier)
        .digest()
        .toString('base64url');
      const codeData = {
        userId: 'user-gone',
        email: 'gone@example.com',
        codeChallenge,
        codeChallengeMethod: 'S256',
        redirectUri: 'http://localhost:9876/callback',
      };
      redisStore.set('cli_code:code-3', JSON.stringify(codeData));
      usersService.findById.mockResolvedValue(null);

      const result = await service.exchangeCode({
        code: 'code-3',
        codeVerifier,
        redirectUri: 'http://localhost:9876/callback',
      });

      expect(result.user.name).toBe('');
    });
  });

  describe('onModuleDestroy', () => {
    it('should disconnect redis', () => {
      service.onModuleDestroy();
      expect(redisMock.disconnect).toHaveBeenCalled();
    });
  });
});
