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
import * as bcrypt from 'bcrypt';
import * as argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { UsersService } from './users.service';
import { ConfigService } from '../config/config.service';
import { MailService } from '../mail/mail.service';
import { MemoryBanksService } from '../memory-banks/memory-banks.service';
import { UserKeyService } from '../crypto/user-key.service';

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
    const valid = await bcrypt.compare(password, hashToCompare);

    if (!user || !valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    let recoveryKey: string | undefined;
    let needsRecoveryKey = false;

    // Try 2-tier DEK lookup (memory → Redis)
    const dek = await this.userKeyService.getDek(user.id);

    if (!user.recoveryKeyHash) {
      // Pre-migration user: generate recovery key, enqueue re-encryption
      const newDek = this.userKeyService.generateDek();
      recoveryKey = newDek.toString('base64');
      const recoveryKeyHash = this.hashRecoveryKey(recoveryKey);
      await this.usersService.updateRecoveryKeyHash(user.id, recoveryKeyHash);
      await this.userKeyService.storeDek(user.id, newDek);

      // Bump key version and enqueue migration from old encryption to new DEK
      const oldKeyVersion = user.keyVersion ?? 1;
      const newKeyVersion = await this.usersService.incrementKeyVersion(user.id);

      // Derive old password-based key for re-encryption (kv>=1 memories)
      let oldKeyBase64 = '';
      if (oldKeyVersion >= 1 && user.encryptionSalt) {
        const salt = Buffer.from(user.encryptionSalt, 'base64');
        const oldKey = (await argon2.hash(password, {
          type: argon2.argon2id,
          raw: true,
          hashLength: 32,
          salt,
          timeCost: 3,
          memoryCost: 19456,
          parallelism: 1,
        })) as Buffer;
        oldKeyBase64 = oldKey.toString('base64');
      }
      await this.reencryptQueue.add('reencrypt-memories', {
        userId: user.id,
        oldKey: oldKeyBase64,
        newKey: newDek.toString('base64'),
        newKeyVersion,
      });
      this.logger.log(
        `Migrated user ${user.id} to recovery key (kv ${oldKeyVersion} → ${newKeyVersion})`,
      );
    } else if (!dek) {
      needsRecoveryKey = true;
    }

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
    let payload: any;
    try {
      payload = this.jwt.verify(oldRefreshToken, {
        secret: this.config.jwtRefreshSecret,
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const tokenHash = this.hashToken(oldRefreshToken);
    const stored = await this.usersService.findRefreshToken(tokenHash);

    if (!stored) {
      throw new UnauthorizedException('Refresh token not found');
    }

    if (stored.revokedAt) {
      throw new UnauthorizedException('Refresh token already used');
    }

    if (new Date(stored.expiresAt) < new Date()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    await this.usersService.revokeRefreshToken(stored.id);
    const tokens = await this.generateTokenPair(payload.sub, payload.email, stored.family);

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

  private async generateTokenPair(userId: string, email: string, family?: string) {
    const tokenFamily = family ?? randomUUID();

    const accessToken = this.jwt.sign(
      { sub: userId, email },
      {
        secret: this.config.jwtAccessSecret,
        expiresIn: this.config.jwtAccessExpiresIn as any,
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
      expiresIn: this.config.jwtRefreshExpiresIn as any,
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

  private sanitizeUser(user: any) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      onboarded: !!user.onboarded,
      plan: ['active', 'trialing'].includes(user.subscriptionStatus) ? 'pro' : 'free',
      createdAt: user.createdAt,
    };
  }
}
