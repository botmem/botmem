import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OAuthController } from '../oauth.controller';
import { OAuthService } from '../oauth.service';
import { UsersService } from '../../user-auth/users.service';
import { FirebaseAuthService } from '../../user-auth/firebase-auth.service';
import { UserKeyService } from '../../crypto/user-key.service';
import { ConfigService } from '../../config/config.service';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

function makeReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, ...overrides } as unknown as Request;
}

const baseBody = {
  clientId: 'client-1',
  scope: 'read write',
  state: 'st',
  codeChallenge: 'ch',
  codeChallengeMethod: 'S256',
  redirectUri: 'http://localhost:3000/callback',
};

describe('OAuthController.authorizeComplete', () => {
  let controller: OAuthController;
  let oauthService: {
    getClient: ReturnType<typeof vi.fn>;
    generateAuthCode: ReturnType<typeof vi.fn>;
  };
  let usersService: { findById: ReturnType<typeof vi.fn>; findByEmail: ReturnType<typeof vi.fn> };
  let firebaseAuthService: {
    verifyIdToken: ReturnType<typeof vi.fn>;
    findOrCreateUser: ReturnType<typeof vi.fn>;
  };
  let userKeyService: { getDek: ReturnType<typeof vi.fn>; storeDek: ReturnType<typeof vi.fn> };
  let jwtService: { verify: ReturnType<typeof vi.fn> };
  let config: Partial<ConfigService>;

  const fakeUser = {
    id: 'u1',
    email: 'test@test.com',
    passwordHash: 'hash',
    recoveryKeyHash: null,
  };
  const fakeClient = {
    clientId: 'client-1',
    clientName: 'Test',
    redirectUris: '["http://localhost:3000/callback"]',
  };

  beforeEach(() => {
    oauthService = {
      getClient: vi.fn().mockResolvedValue(fakeClient),
      generateAuthCode: vi.fn().mockResolvedValue('auth-code-123'),
    };
    usersService = {
      findById: vi.fn().mockResolvedValue(fakeUser),
      findByEmail: vi.fn().mockResolvedValue(fakeUser),
    };
    firebaseAuthService = {
      verifyIdToken: vi.fn().mockResolvedValue({ uid: 'fb-uid-1', email: 'test@test.com' }),
      findOrCreateUser: vi.fn().mockResolvedValue({ user: fakeUser }),
    };
    userKeyService = {
      getDek: vi.fn().mockResolvedValue(Buffer.from('dek')),
      storeDek: vi.fn(),
    };
    jwtService = { verify: vi.fn().mockReturnValue({ sub: 'u1' }) };
    config = {
      get jwtAccessSecret() {
        return 'test-secret';
      },
      get authProvider() {
        return 'local' as const;
      },
    };

    controller = new OAuthController(
      oauthService as unknown as OAuthService,
      usersService as unknown as UsersService,
      firebaseAuthService as unknown as FirebaseAuthService,
      userKeyService as unknown as UserKeyService,
      jwtService as unknown as JwtService,
      config as ConfigService,
    );
  });

  it('authenticates with native JWT Bearer token', async () => {
    const req = makeReq({ headers: { authorization: 'Bearer native-jwt' } });
    const result = await controller.authorizeComplete(req, baseBody);

    expect(jwtService.verify).toHaveBeenCalledWith('native-jwt', { secret: 'test-secret' });
    expect(usersService.findById).toHaveBeenCalledWith('u1');
    expect(result.redirect_uri).toContain('code=auth-code-123');
  });

  it('authenticates with email/password when no Bearer token', async () => {
    const req = makeReq();
    // Mock bcrypt at module level
    vi.mock('bcrypt', () => ({ compare: vi.fn().mockResolvedValue(true) }));

    const result = await controller.authorizeComplete(req, {
      ...baseBody,
      email: 'test@test.com',
      password: 'pass123',
    });

    expect(usersService.findByEmail).toHaveBeenCalledWith('test@test.com');
    expect(result.redirect_uri).toContain('code=auth-code-123');
  });

  it('falls back to Firebase token when native JWT fails and authProvider=firebase', async () => {
    jwtService.verify.mockImplementation(() => {
      throw new Error('invalid');
    });
    config = { ...config, authProvider: 'firebase' as const };
    controller = new OAuthController(
      oauthService as unknown as OAuthService,
      usersService as unknown as UsersService,
      firebaseAuthService as unknown as FirebaseAuthService,
      userKeyService as unknown as UserKeyService,
      jwtService as unknown as JwtService,
      config as ConfigService,
    );

    const req = makeReq({ headers: { authorization: 'Bearer firebase-id-token' } });
    const result = await controller.authorizeComplete(req, baseBody);

    expect(jwtService.verify).toHaveBeenCalled();
    expect(firebaseAuthService.verifyIdToken).toHaveBeenCalledWith('firebase-id-token');
    expect(firebaseAuthService.findOrCreateUser).toHaveBeenCalled();
    expect(result.redirect_uri).toContain('code=auth-code-123');
  });

  it('throws when native JWT fails and authProvider=local (no Firebase fallback)', async () => {
    jwtService.verify.mockImplementation(() => {
      throw new Error('invalid');
    });

    const req = makeReq({ headers: { authorization: 'Bearer bad-token' } });

    await expect(controller.authorizeComplete(req, baseBody)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(firebaseAuthService.verifyIdToken).not.toHaveBeenCalled();
  });

  it('throws when Firebase verification also fails', async () => {
    jwtService.verify.mockImplementation(() => {
      throw new Error('invalid');
    });
    firebaseAuthService.verifyIdToken.mockRejectedValue(new Error('bad firebase token'));
    config = { ...config, authProvider: 'firebase' as const };
    controller = new OAuthController(
      oauthService as unknown as OAuthService,
      usersService as unknown as UsersService,
      firebaseAuthService as unknown as FirebaseAuthService,
      userKeyService as unknown as UserKeyService,
      jwtService as unknown as JwtService,
      config as ConfigService,
    );

    const req = makeReq({ headers: { authorization: 'Bearer bad-token' } });

    await expect(controller.authorizeComplete(req, baseBody)).rejects.toThrow(
      'Invalid session token',
    );
  });

  it('throws when no auth method provided', async () => {
    const req = makeReq();

    await expect(controller.authorizeComplete(req, baseBody)).rejects.toThrow(
      'Provide email/password or Authorization header',
    );
  });
});
