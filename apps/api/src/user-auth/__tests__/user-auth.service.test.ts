import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { UserAuthService } from '../user-auth.service';
import { UsersService } from '../users.service';
import { ConfigService } from '../../config/config.service';
import { MailService } from '../../mail/mail.service';
import { MemoryBanksService } from '../../memory-banks/memory-banks.service';
import { UserKeyService } from '../../crypto/user-key.service';
import { getQueueToken } from '@nestjs/bullmq';
import * as bcrypt from 'bcrypt';

// Mock bcrypt for faster tests
vi.mock('bcrypt', async () => {
  const actual = await vi.importActual<typeof import('bcrypt')>('bcrypt');
  return {
    ...actual,
    hash: vi.fn().mockResolvedValue('$2b$12$hashed'),
    compare: vi.fn(),
  };
});

describe('UserAuthService', () => {
  let service: UserAuthService;
  let usersService: Partial<Record<keyof UsersService, ReturnType<typeof vi.fn>>>;
  let jwtService: Partial<Record<keyof JwtService, ReturnType<typeof vi.fn>>>;
  let configService: Partial<ConfigService>;

  const mockUser = {
    id: 'user-1',
    email: 'test@test.com',
    passwordHash: '$2b$12$hashed',
    name: 'Test User',
    onboarded: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };

  beforeEach(async () => {
    usersService = {
      createUser: vi.fn().mockResolvedValue(mockUser),
      findByEmail: vi.fn().mockResolvedValue(null),
      findById: vi.fn().mockResolvedValue(mockUser),
      saveRefreshToken: vi.fn().mockResolvedValue({ id: 'rt-1' }),
      findRefreshToken: vi.fn().mockResolvedValue(null),
      revokeRefreshToken: vi.fn().mockResolvedValue(undefined),
      revokeTokenFamily: vi.fn().mockResolvedValue(undefined),
      revokeAllUserTokens: vi.fn().mockResolvedValue(undefined),
      updateEncryptionSalt: vi.fn().mockResolvedValue(undefined),
      updateRecoveryKeyHash: vi.fn().mockResolvedValue(undefined),
      incrementKeyVersion: vi.fn().mockResolvedValue(2),
      updatePasswordHash: vi.fn().mockResolvedValue(undefined),
    };

    jwtService = {
      sign: vi.fn().mockReturnValue('mock-jwt-token'),
      verify: vi.fn().mockReturnValue({ sub: 'user-1', email: 'test@test.com' }),
    };

    configService = {
      get jwtAccessSecret() {
        return 'test-access-secret';
      },
      get jwtRefreshSecret() {
        return 'test-refresh-secret';
      },
      get jwtAccessExpiresIn() {
        return '15m';
      },
      get jwtRefreshExpiresIn() {
        return '7d';
      },
      get frontendUrl() {
        return 'http://localhost:12412';
      },
    };

    const module = await Test.createTestingModule({
      providers: [
        UserAuthService,
        { provide: UsersService, useValue: usersService },
        { provide: JwtService, useValue: jwtService },
        { provide: ConfigService, useValue: configService },
        { provide: MailService, useValue: { sendPasswordResetEmail: vi.fn() } },
        {
          provide: MemoryBanksService,
          useValue: {
            getOrCreateDefault: vi.fn().mockResolvedValue({ id: 'bank-1', name: 'Default' }),
          },
        },
        {
          provide: UserKeyService,
          useValue: {
            deriveAndStore: vi.fn().mockResolvedValue(undefined),
            removeKey: vi.fn(),
            generateDek: vi.fn().mockReturnValue(Buffer.from('a'.repeat(32))),
            getDek: vi.fn().mockResolvedValue(Buffer.from('a'.repeat(32))),
            storeDek: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: getQueueToken('reencrypt'),
          useValue: { add: vi.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get(UserAuthService);
  });

  describe('register', () => {
    it('creates user with hashed password and returns tokens', async () => {
      (bcrypt.compare as any).mockResolvedValue(true);
      const result = await service.register('test@test.com', 'password123', 'Test User');

      expect(usersService.createUser).toHaveBeenCalledWith(
        'test@test.com',
        '$2b$12$hashed',
        'Test User',
        expect.any(String),
      );
      expect(result.accessToken).toBe('mock-jwt-token');
      expect(result.user.email).toBe('test@test.com');
      expect(result.user.name).toBe('Test User');
    });

    it('rejects passwords shorter than 8 characters', async () => {
      await expect(service.register('test@test.com', 'short', 'Test User')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects duplicate email with ConflictException', async () => {
      usersService.createUser!.mockRejectedValue(
        new Error('UNIQUE constraint failed: users.email'),
      );

      await expect(service.register('test@test.com', 'password123', 'Test User')).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('login', () => {
    it('returns tokens with valid credentials', async () => {
      usersService.findByEmail!.mockResolvedValue(mockUser);
      (bcrypt.compare as any).mockResolvedValue(true);

      const result = await service.login('test@test.com', 'password123');

      expect(result.accessToken).toBe('mock-jwt-token');
      expect(result.user.email).toBe('test@test.com');
    });

    it('throws UnauthorizedException with wrong password', async () => {
      usersService.findByEmail!.mockResolvedValue(mockUser);
      (bcrypt.compare as any).mockResolvedValue(false);

      await expect(service.login('test@test.com', 'wrongpassword')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException with non-existent email', async () => {
      usersService.findByEmail!.mockResolvedValue(null);
      (bcrypt.compare as any).mockResolvedValue(false);

      await expect(service.login('nobody@test.com', 'password123')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('always runs bcrypt.compare even when user not found', async () => {
      usersService.findByEmail!.mockResolvedValue(null);
      (bcrypt.compare as any).mockResolvedValue(false);

      try {
        await service.login('nobody@test.com', 'password123');
      } catch {
        // expected
      }

      expect(bcrypt.compare).toHaveBeenCalled();
    });
  });

  describe('refresh', () => {
    it('rotates token and returns new access token', async () => {
      const storedToken = {
        id: 'rt-1',
        userId: 'user-1',
        tokenHash: 'some-hash',
        family: 'family-1',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        revokedAt: null,
        createdAt: '2026-01-01T00:00:00Z',
      };

      usersService.findRefreshToken!.mockResolvedValue(storedToken);

      const result = await service.refresh('old-refresh-token');

      expect(usersService.revokeRefreshToken).toHaveBeenCalledWith('rt-1');
      expect(result.accessToken).toBe('mock-jwt-token');
    });

    it('revokes entire token family when revoked token is replayed (theft detection)', async () => {
      const revokedToken = {
        id: 'rt-1',
        userId: 'user-1',
        tokenHash: 'some-hash',
        family: 'family-1',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        revokedAt: '2026-01-01T00:00:00Z',
        createdAt: '2026-01-01T00:00:00Z',
      };

      usersService.findRefreshToken!.mockResolvedValue(revokedToken);

      await expect(service.refresh('old-refresh-token')).rejects.toThrow(UnauthorizedException);
      expect(usersService.revokeTokenFamily).toHaveBeenCalledWith('family-1');
    });
  });
});
