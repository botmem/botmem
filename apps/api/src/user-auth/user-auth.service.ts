import {
  Injectable,
  BadRequestException,
  ConflictException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { UsersService } from './users.service';
import { ConfigService } from '../config/config.service';
import { MailService } from '../mail/mail.service';
import { MemoryBanksService } from '../memory-banks/memory-banks.service';
import { UserKeyService } from '../crypto/user-key.service';
import { AnalyticsService } from '../analytics/analytics.service';

// Dummy hash used for timing attack prevention when user not found
const DUMMY_HASH = '$2b$12$LJ3m4ys3Gz8h/.0MStlQiee6RjGHPnRYVwO3BSXK8X8A.VFj0e6Vu';

@Injectable()
export class UserAuthService {
  private readonly logger = new Logger(UserAuthService.name);

  constructor(
    private jwt: JwtService,
    private usersService: UsersService,
    private config: ConfigService,
    private mailService: MailService,
    private memoryBanksService: MemoryBanksService,
    private userKeyService: UserKeyService,
    private analytics: AnalyticsService,
    @InjectQueue('reencrypt') private reencryptQueue: Queue,
  ) {}

  private hashRecoveryKey(recoveryKey: string): string {
    return createHash('sha256').update(recoveryKey).digest('hex');
  }

  async register(email: string, password: string, name: string) {
    if (!password || password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters long');
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const salt = randomBytes(16);
    const encryptionSalt = salt.toString('base64');

    // Generate random DEK — this IS the recovery key
    const dek = this.userKeyService.generateDek();
    const recoveryKey = dek.toString('base64');
    const recoveryKeyHash = this.hashRecoveryKey(recoveryKey);

    let user: Awaited<ReturnType<typeof this.usersService.createUser>>;
    try {
      user = await this.usersService.createUser(email, passwordHash, name, encryptionSalt);
    } catch (err: unknown) {
      const dbErr = err as { message?: string; code?: string; constraint?: string };
      if (
        dbErr.message?.includes('UNIQUE constraint failed') ||
        dbErr.code === '23505' ||
        dbErr.constraint
      ) {
        throw new ConflictException('Email already registered');
      }
      throw err;
    }

    // Store recovery key hash and cache DEK
    await this.usersService.updateRecoveryKeyHash(user!.id, recoveryKeyHash);
    await this.usersService.incrementKeyVersion(user!.id); // bump to 2
    await this.userKeyService.storeDek(user!.id, dek);

    // Create default memory bank
    await this.memoryBanksService.getOrCreateDefault(user!.id);

    this.analytics.capture('user_registered', { auth_method: 'email' }, user!.id);

    const tokens = await this.generateTokenPair(user!.id, user!.email);
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: this.sanitizeUser(user!),
      recoveryKey, // shown to user ONCE
    };
  }

  async login(email: string, password: string) {
    const user = await this.usersService.findByEmail(email);

    const hashToCompare = user?.passwordHash ?? DUMMY_HASH;

    // Firebase sentinel hashes (e.g. "firebase:<uid>") are not valid bcrypt —
    // bcrypt.compare would throw, leaking that the account exists via a 500.
    // Treat them the same as a failed password check.
    const isFirebaseHash = hashToCompare.startsWith('firebase:');
    const valid = isFirebaseHash ? false : await bcrypt.compare(password, hashToCompare);

    if (!user || !valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    let recoveryKey: string | undefined;
    let needsRecoveryKey = false;

    // Try 2-tier DEK lookup (memory → Redis)
    const dek = await this.userKeyService.getDek(user.id);

    if (!user.recoveryKeyHash) {
      // Pre-recovery-key user — should not exist after DB wipe (2026-03-09)
      throw new BadRequestException('Account missing recovery key. Please contact support.');
    } else if (!dek) {
      needsRecoveryKey = true;
    }

    this.analytics.capture(
      'user_logged_in',
      { auth_method: 'email', needs_recovery_key: needsRecoveryKey },
      user.id,
    );

    const tokens = await this.generateTokenPair(user.id, user.email);
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: this.sanitizeUser(user),
      needsRecoveryKey,
      recoveryKey,
    };
  }

  /**
   * Verify recovery key and restore DEK into cache.
   */
  async submitRecoveryKey(userId: string, recoveryKey: string) {
    const user = await this.usersService.findById(userId);
    if (!user) throw new UnauthorizedException('User not found');

    const hash = this.hashRecoveryKey(recoveryKey);
    if (hash !== user.recoveryKeyHash) {
      throw new BadRequestException('Invalid recovery key');
    }

    const dek = Buffer.from(recoveryKey, 'base64');
    await this.userKeyService.storeDek(userId, dek);

    this.logger.log(`Recovery key accepted for user ${userId}, DEK restored`);
  }

  async refresh(oldRefreshToken: string) {
    let payload: Record<string, unknown>;
    try {
      payload = this.jwt.verify(oldRefreshToken, {
        secret: this.config.jwtRefreshSecret,
      }) as Record<string, unknown>;
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const tokenHash = this.hashToken(oldRefreshToken);
    const stored = await this.usersService.findRefreshToken(tokenHash);

    if (!stored) {
      throw new UnauthorizedException('Refresh token not found');
    }

    if (stored.revokedAt) {
      await this.usersService.revokeTokenFamily(stored.family);
      throw new UnauthorizedException('Refresh token already used');
    }

    if (new Date(stored.expiresAt) < new Date()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    await this.usersService.revokeRefreshToken(stored.id);
    const tokens = await this.generateTokenPair(
      payload.sub as string,
      payload.email as string,
      stored.family,
    );

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  async logout(refreshToken: string) {
    const tokenHash = this.hashToken(refreshToken);
    const stored = await this.usersService.findRefreshToken(tokenHash);
    if (stored) {
      await this.usersService.revokeRefreshToken(stored.id);
    }
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await this.usersService.findByEmail(email);
    if (!user) return;

    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');

    await this.usersService.invalidateUserResets(user.id);

    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await this.usersService.createPasswordReset(user.id, tokenHash, expiresAt);

    const resetUrl = `${this.config.frontendUrl}/reset-password?token=${token}`;
    await this.mailService.sendResetEmail(user.email, resetUrl);
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    if (!newPassword || newPassword.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters long');
    }

    const tokenHash = createHash('sha256').update(token).digest('hex');
    const reset = await this.usersService.findPasswordReset(tokenHash);

    if (!reset) throw new BadRequestException('Invalid or expired reset token');
    if (reset.usedAt) throw new BadRequestException('Reset token already used');
    if (new Date(reset.expiresAt) < new Date())
      throw new BadRequestException('Reset token expired');

    // Just update password — encryption is independent of password
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await this.usersService.updatePasswordHash(reset.userId, passwordHash);
    await this.usersService.markResetUsed(reset.id);
    await this.usersService.revokeAllUserTokens(reset.userId);

    this.analytics.capture('password_reset', {}, reset.userId);
    this.logger.log(`Password reset for user ${reset.userId} — encryption unchanged`);
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string) {
    if (!newPassword || newPassword.length < 8) {
      throw new BadRequestException('New password must be at least 8 characters long');
    }

    const user = await this.usersService.findById(userId);
    if (!user) throw new BadRequestException('User not found');

    const valid = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Current password is incorrect');

    // Just update password hash — encryption is independent
    const newPasswordHash = await bcrypt.hash(newPassword, 12);
    await this.usersService.updatePasswordHash(userId, newPasswordHash);
    await this.usersService.revokeAllUserTokens(userId);

    this.logger.log(`Password changed for user ${userId} — encryption unchanged`);
  }

  /**
   * Generate token pair for an already-authenticated user (used by CLI OAuth flow).
   */
  async generateTokensForUser(userId: string, email: string) {
    return this.generateTokenPair(userId, email);
  }

  private async generateTokenPair(userId: string, email: string, family?: string) {
    const tokenFamily = family ?? randomUUID();

    const accessToken = this.jwt.sign(
      { sub: userId, email },
      {
        secret: this.config.jwtAccessSecret,
        expiresIn: this.config.jwtAccessExpiresIn as unknown as import('ms').StringValue,
        algorithm: 'HS256',
      },
    );

    const refreshPayload = {
      sub: userId,
      email,
      jti: randomBytes(32).toString('hex'),
    };
    const refreshToken = this.jwt.sign(refreshPayload, {
      secret: this.config.jwtRefreshSecret,
      expiresIn: this.config.jwtRefreshExpiresIn as unknown as import('ms').StringValue,
      algorithm: 'HS256',
    });

    const tokenHash = this.hashToken(refreshToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await this.usersService.saveRefreshToken(userId, tokenHash, tokenFamily, expiresAt);

    return { accessToken, refreshToken };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private sanitizeUser(user: {
    id: string;
    email: string;
    name: string | null;
    onboarded: boolean | null;
    subscriptionStatus: string | null;
    createdAt: Date | string;
  }) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      onboarded: !!user.onboarded,
      plan: ['active', 'trialing'].includes(user.subscriptionStatus ?? '') ? 'pro' : 'free',
      createdAt: user.createdAt,
    };
  }
}
