import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { OAuthService } from '../oauth.service';
import { DbService } from '../../db/db.service';
import { ConfigService } from '../../config/config.service';
import { createHash, randomBytes } from 'crypto';

// Helper: compute S256 code challenge from verifier
function computeS256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest().toString('base64url');
}

describe('OAuthService', () => {
  let service: OAuthService;
  let jwtService: { sign: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn> };
  let configService: Partial<ConfigService>;

  // Track all inserts
  let allInserts: any[];

  beforeEach(async () => {
    allInserts = [];

    const mockDb = {
      insert: vi.fn().mockImplementation(() => ({
        values: vi.fn().mockImplementation((vals: any) => {
          allInserts.push(vals);
          return Promise.resolve();
        }),
      })),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      update: vi.fn().mockImplementation(() => ({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      })),
    };

    jwtService = {
      sign: vi.fn().mockReturnValue('mock-oauth-jwt'),
      verify: vi.fn().mockReturnValue({
        iss: 'http://localhost:12412',
        sub: 'user-1',
        aud: 'http://localhost:12412/mcp',
        scope: 'read write',
        client_id: 'client-1',
      }),
    };

    configService = {
      get oauthJwtSecret() {
        return 'test-oauth-secret';
      },
      get baseUrl() {
        return 'http://localhost:12412';
      },
      get frontendUrl() {
        return 'http://localhost:12412';
      },
    };

    const module = await Test.createTestingModule({
      providers: [
        OAuthService,
        { provide: DbService, useValue: { db: mockDb } },
        { provide: JwtService, useValue: jwtService },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get(OAuthService);
  });

  describe('registerClient', () => {
    it('stores and returns client with generated UUID', async () => {
      const result = await service.registerClient(
        'Test App',
        ['http://localhost:3000/callback'],
        ['authorization_code', 'refresh_token'],
      );

      expect(result.client_id).toBeDefined();
      expect(result.client_name).toBe('Test App');
      expect(result.redirect_uris).toEqual(['http://localhost:3000/callback']);
      expect(result.grant_types).toEqual(['authorization_code', 'refresh_token']);
      expect(allInserts).toHaveLength(1);
    });

    it('defaults grant_types when not provided', async () => {
      const result = await service.registerClient('Test App', ['http://localhost:3000/callback']);

      expect(result.grant_types).toEqual(['authorization_code', 'refresh_token']);
    });
  });

  describe('generateAuthCode', () => {
    it('creates code with 10-minute expiry', async () => {
      const code = await service.generateAuthCode(
        'user-1',
        'client-1',
        'http://localhost:3000/callback',
        'read write',
        'challenge123',
      );

      expect(code).toBeDefined();
      expect(typeof code).toBe('string');
      expect(code.length).toBeGreaterThan(10);
      expect(allInserts).toHaveLength(1);
      expect(allInserts[0].userId).toBe('user-1');
      expect(allInserts[0].clientId).toBe('client-1');

      const expiresAt = new Date(allInserts[0].expiresAt);
      const now = new Date();
      const diffMs = expiresAt.getTime() - now.getTime();
      // Should be ~10 minutes (600000ms), allow 5s tolerance
      expect(diffMs).toBeGreaterThan(595000);
      expect(diffMs).toBeLessThan(605000);
    });
  });

  describe('validateAndConsumeCode', () => {
    it('validates PKCE S256 correctly and marks code used', async () => {
      const verifier = randomBytes(32).toString('base64url');
      const challenge = computeS256Challenge(verifier);

      const storedCode = {
        code: 'test-code',
        userId: 'user-1',
        clientId: 'client-1',
        redirectUri: 'http://localhost:3000/callback',
        scope: 'read write',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        expiresAt: new Date(Date.now() + 600000),
        usedAt: null,
      };

      // Override the select mock for this test
      const dbService = (service as any).db;
      dbService.db.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([storedCode]),
          }),
        }),
      });

      const result = await service.validateAndConsumeCode(
        'test-code',
        'client-1',
        'http://localhost:3000/callback',
        verifier,
      );

      expect(result.userId).toBe('user-1');
      expect(result.scope).toBe('read write');
      expect(dbService.db.update).toHaveBeenCalled();
    });

    it('rejects expired code', async () => {
      const storedCode = {
        code: 'test-code',
        userId: 'user-1',
        clientId: 'client-1',
        redirectUri: 'http://localhost:3000/callback',
        scope: 'read write',
        codeChallenge: 'challenge',
        codeChallengeMethod: 'S256',
        expiresAt: new Date(Date.now() - 1000), // expired
        usedAt: null,
      };

      const dbService = (service as any).db;
      dbService.db.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([storedCode]),
          }),
        }),
      });

      await expect(
        service.validateAndConsumeCode('test-code', 'client-1', 'http://localhost:3000/callback', 'verifier'),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects already-used code', async () => {
      const storedCode = {
        code: 'test-code',
        userId: 'user-1',
        clientId: 'client-1',
        redirectUri: 'http://localhost:3000/callback',
        scope: 'read write',
        codeChallenge: 'challenge',
        codeChallengeMethod: 'S256',
        expiresAt: new Date(Date.now() + 600000),
        usedAt: new Date(), // already used
      };

      const dbService = (service as any).db;
      dbService.db.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([storedCode]),
          }),
        }),
      });

      await expect(
        service.validateAndConsumeCode('test-code', 'client-1', 'http://localhost:3000/callback', 'verifier'),
      ).rejects.toThrow('Authorization code already used');
    });

    it('rejects wrong client_id', async () => {
      const storedCode = {
        code: 'test-code',
        userId: 'user-1',
        clientId: 'client-1',
        redirectUri: 'http://localhost:3000/callback',
        scope: 'read write',
        codeChallenge: 'challenge',
        codeChallengeMethod: 'S256',
        expiresAt: new Date(Date.now() + 600000),
        usedAt: null,
      };

      const dbService = (service as any).db;
      dbService.db.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([storedCode]),
          }),
        }),
      });

      await expect(
        service.validateAndConsumeCode('test-code', 'wrong-client', 'http://localhost:3000/callback', 'verifier'),
      ).rejects.toThrow('Client ID mismatch');
    });

    it('rejects invalid code', async () => {
      const dbService = (service as any).db;
      dbService.db.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      await expect(
        service.validateAndConsumeCode('invalid', 'client-1', 'http://localhost:3000/callback', 'verifier'),
      ).rejects.toThrow('Invalid authorization code');
    });

    it('rejects wrong PKCE verifier', async () => {
      const verifier = randomBytes(32).toString('base64url');
      const challenge = computeS256Challenge(verifier);

      const storedCode = {
        code: 'test-code',
        userId: 'user-1',
        clientId: 'client-1',
        redirectUri: 'http://localhost:3000/callback',
        scope: 'read write',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        expiresAt: new Date(Date.now() + 600000),
        usedAt: null,
      };

      const dbService = (service as any).db;
      dbService.db.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([storedCode]),
          }),
        }),
      });

      await expect(
        service.validateAndConsumeCode('test-code', 'client-1', 'http://localhost:3000/callback', 'wrong-verifier'),
      ).rejects.toThrow('PKCE validation failed');
    });
  });

  describe('issueTokens', () => {
    it('returns valid JWT access token and refresh token', async () => {
      const result = await service.issueTokens('user-1', 'read write', 'client-1');

      expect(result.access_token).toBe('mock-oauth-jwt');
      expect(result.token_type).toBe('Bearer');
      expect(result.expires_in).toBe(3600);
      expect(result.refresh_token).toBeDefined();
      expect(result.scope).toBe('read write');
      expect(allInserts).toHaveLength(1);

      // Verify JWT was signed with correct claims
      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          iss: 'http://localhost:12412',
          sub: 'user-1',
          aud: 'http://localhost:12412/mcp',
          scope: 'read write',
          client_id: 'client-1',
        }),
        expect.objectContaining({
          secret: 'test-oauth-secret',
          expiresIn: 3600,
          algorithm: 'HS256',
        }),
      );
    });
  });

  describe('refreshTokens', () => {
    it('rotates tokens when valid refresh token provided', async () => {
      const rawToken = randomBytes(48).toString('base64url');
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');

      const storedToken = {
        id: 'rt-1',
        tokenHash,
        userId: 'user-1',
        clientId: 'client-1',
        scope: 'read write',
        expiresAt: new Date(Date.now() + 86400000),
        revokedAt: null,
      };

      const dbService = (service as any).db;
      dbService.db.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([storedToken]),
          }),
        }),
      });

      const result = await service.refreshTokens(rawToken, 'client-1');

      expect(result.access_token).toBe('mock-oauth-jwt');
      expect(result.token_type).toBe('Bearer');
      expect(result.refresh_token).toBeDefined();
      // Old token should be revoked (update called)
      expect(dbService.db.update).toHaveBeenCalled();
    });

    it('rejects revoked refresh token', async () => {
      const rawToken = randomBytes(48).toString('base64url');
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');

      const storedToken = {
        id: 'rt-1',
        tokenHash,
        userId: 'user-1',
        clientId: 'client-1',
        scope: 'read write',
        expiresAt: new Date(Date.now() + 86400000),
        revokedAt: new Date(), // revoked
      };

      const dbService = (service as any).db;
      dbService.db.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([storedToken]),
          }),
        }),
      });

      await expect(service.refreshTokens(rawToken, 'client-1')).rejects.toThrow(
        'Refresh token revoked',
      );
    });

    it('rejects expired refresh token', async () => {
      const rawToken = randomBytes(48).toString('base64url');
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');

      const storedToken = {
        id: 'rt-1',
        tokenHash,
        userId: 'user-1',
        clientId: 'client-1',
        scope: 'read write',
        expiresAt: new Date(Date.now() - 1000), // expired
        revokedAt: null,
      };

      const dbService = (service as any).db;
      dbService.db.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([storedToken]),
          }),
        }),
      });

      await expect(service.refreshTokens(rawToken, 'client-1')).rejects.toThrow(
        'Refresh token expired',
      );
    });

    it('rejects wrong client_id', async () => {
      const rawToken = randomBytes(48).toString('base64url');
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');

      const storedToken = {
        id: 'rt-1',
        tokenHash,
        userId: 'user-1',
        clientId: 'client-1',
        scope: 'read write',
        expiresAt: new Date(Date.now() + 86400000),
        revokedAt: null,
      };

      const dbService = (service as any).db;
      dbService.db.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([storedToken]),
          }),
        }),
      });

      await expect(service.refreshTokens(rawToken, 'wrong-client')).rejects.toThrow(
        'Client ID mismatch',
      );
    });
  });

  describe('revokeToken', () => {
    it('marks token as revoked', async () => {
      const dbService = (service as any).db;

      await service.revokeToken('some-token');

      expect(dbService.db.update).toHaveBeenCalled();
    });
  });

  describe('verifyAccessToken', () => {
    it('returns claims for valid token', () => {
      const result = service.verifyAccessToken('valid-token');

      expect(result.sub).toBe('user-1');
      expect(result.scope).toBe('read write');
      expect(result.aud).toBe('http://localhost:12412/mcp');
      expect(jwtService.verify).toHaveBeenCalledWith('valid-token', {
        secret: 'test-oauth-secret',
        algorithms: ['HS256'],
      });
    });

    it('throws for invalid token', () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error('invalid signature');
      });

      expect(() => service.verifyAccessToken('invalid-token')).toThrow(UnauthorizedException);
    });

    it('throws for wrong audience', () => {
      jwtService.verify.mockReturnValue({
        sub: 'user-1',
        aud: 'http://wrong-audience/mcp',
        scope: 'read write',
      });

      expect(() => service.verifyAccessToken('valid-token')).toThrow('Invalid token audience');
    });
  });
});
