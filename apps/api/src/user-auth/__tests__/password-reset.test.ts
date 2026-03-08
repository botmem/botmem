import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { UserAuthService } from '../user-auth.service';
import { UsersService } from '../users.service';
import { MailService } from '../../mail/mail.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '../../config/config.service';
import * as crypto from 'crypto';

describe('Password Reset', () => {
  let authService: UserAuthService;
  let usersService: Partial<UsersService>;
  let mailService: Partial<MailService>;
  let configService: Partial<ConfigService>;
  let jwtService: Partial<JwtService>;

  beforeEach(() => {
    usersService = {
      findByEmail: vi.fn(),
      createPasswordReset: vi.fn(),
      invalidateUserResets: vi.fn(),
      findPasswordReset: vi.fn(),
      updatePasswordHash: vi.fn(),
      revokeAllUserTokens: vi.fn(),
      markResetUsed: vi.fn(),
    };

    mailService = {
      sendResetEmail: vi.fn().mockResolvedValue(undefined),
    };

    configService = {
      frontendUrl: 'http://localhost:12412',
      jwtAccessSecret: 'test-access-secret',
      jwtRefreshSecret: 'test-refresh-secret',
      jwtAccessExpiresIn: '15m',
      jwtRefreshExpiresIn: '7d',
    };

    jwtService = {
      sign: vi.fn().mockReturnValue('mock-jwt-token'),
      verify: vi.fn(),
    };

    authService = new UserAuthService(
      jwtService as JwtService,
      usersService as UsersService,
      configService as ConfigService,
      mailService as MailService,
    );
  });

  describe('forgotPassword', () => {
    it('should generate token, store hash, and send email when user exists', async () => {
      const mockUser = { id: 'user-1', email: 'test@test.com', name: 'Test' };
      (usersService.findByEmail as any).mockResolvedValue(mockUser);

      await authService.forgotPassword('test@test.com');

      expect(usersService.findByEmail).toHaveBeenCalledWith('test@test.com');
      expect(usersService.invalidateUserResets).toHaveBeenCalledWith('user-1');
      expect(usersService.createPasswordReset).toHaveBeenCalledWith(
        'user-1',
        expect.any(String), // token hash
        expect.any(String), // expiresAt
      );
      expect(mailService.sendResetEmail).toHaveBeenCalledWith(
        'test@test.com',
        expect.stringContaining('http://localhost:12412/reset-password?token='),
      );
    });

    it('should not throw when user does not exist (no email enumeration)', async () => {
      (usersService.findByEmail as any).mockResolvedValue(null);

      await expect(authService.forgotPassword('nonexistent@test.com')).resolves.not.toThrow();

      expect(usersService.createPasswordReset).not.toHaveBeenCalled();
      expect(mailService.sendResetEmail).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword', () => {
    const rawToken = 'test-reset-token';
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    it('should update password and revoke tokens with valid token', async () => {
      const mockReset = {
        id: 'reset-1',
        userId: 'user-1',
        tokenHash,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        usedAt: null,
      };
      (usersService.findPasswordReset as any).mockResolvedValue(mockReset);

      await authService.resetPassword(rawToken, 'newpassword123');

      expect(usersService.updatePasswordHash).toHaveBeenCalledWith(
        'user-1',
        expect.any(String), // bcrypt hash
      );
      expect(usersService.revokeAllUserTokens).toHaveBeenCalledWith('user-1');
    });

    it('should reject expired token', async () => {
      const mockReset = {
        id: 'reset-1',
        userId: 'user-1',
        tokenHash,
        expiresAt: new Date(Date.now() - 1000).toISOString(), // expired
        usedAt: null,
      };
      (usersService.findPasswordReset as any).mockResolvedValue(mockReset);

      await expect(authService.resetPassword(rawToken, 'newpassword123'))
        .rejects.toThrow(BadRequestException);
    });

    it('should reject already-used token', async () => {
      const mockReset = {
        id: 'reset-1',
        userId: 'user-1',
        tokenHash,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        usedAt: new Date().toISOString(), // already used
      };
      (usersService.findPasswordReset as any).mockResolvedValue(mockReset);

      await expect(authService.resetPassword(rawToken, 'newpassword123'))
        .rejects.toThrow(BadRequestException);
    });

    it('should reject invalid token', async () => {
      (usersService.findPasswordReset as any).mockResolvedValue(null);

      await expect(authService.resetPassword('invalid-token', 'newpassword123'))
        .rejects.toThrow(BadRequestException);
    });

    it('should reject short password', async () => {
      await expect(authService.resetPassword(rawToken, 'short'))
        .rejects.toThrow(BadRequestException);
    });

    it('should mark token as used after successful reset', async () => {
      const mockReset = {
        id: 'reset-1',
        userId: 'user-1',
        tokenHash,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        usedAt: null,
      };
      (usersService.findPasswordReset as any).mockResolvedValue(mockReset);

      await authService.resetPassword(rawToken, 'newpassword123');

      expect(usersService.markResetUsed).toHaveBeenCalledWith('reset-1');
      expect(usersService.revokeAllUserTokens).toHaveBeenCalledWith('user-1');
    });
  });
});
