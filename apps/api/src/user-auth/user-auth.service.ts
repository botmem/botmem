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

  async register(email: string, password: string, name: string) {
    if (!password || password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters long');
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Generate per-user encryption salt for E2EE key derivation
    const salt = randomBytes(16);
    const encryptionSalt = salt.toString('base64');

    let user: any;
    try {
      user = await this.usersService.createUser(email, passwordHash, name, encryptionSalt);
    } catch (err: any) {
      // PostgreSQL unique constraint error (code 23505)
      if (
        err?.message?.includes('UNIQUE constraint failed') ||
        err?.code === '23505' ||
        err?.constraint
      ) {
        throw new ConflictException('Email already registered');
      }
      throw err;
    }

    // Derive and cache user encryption key in memory
    await this.userKeyService.deriveAndStore(user!.id, password, salt);

    // Create default memory bank for the new user
    await this.memoryBanksService.getOrCreateDefault(user!.id);

    const tokens = await this.generateTokenPair(user!.id, user!.email);
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: this.sanitizeUser(user!),
    };
  }

  async login(email: string, password: string) {
    const user = await this.usersService.findByEmail(email);

    // Always run bcrypt.compare to prevent timing attacks
    const hashToCompare = user?.passwordHash ?? DUMMY_HASH;
    const valid = await bcrypt.compare(password, hashToCompare);

    if (!user || !valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Derive and cache user encryption key
    let encryptionSalt = user.encryptionSalt;
    if (!encryptionSalt) {
      // Legacy user created before E2EE -- generate salt on first login
      const salt = randomBytes(16);
      encryptionSalt = salt.toString('base64');
      await this.usersService.updateEncryptionSalt(user.id, encryptionSalt);
      this.logger.log(`Generated encryption salt for legacy user ${user.id}`);
    }
    await this.userKeyService.deriveAndStore(
      user.id,
      password,
      Buffer.from(encryptionSalt, 'base64'),
    );

    const tokens = await this.generateTokenPair(user.id, user.email);
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: this.sanitizeUser(user),
    };
  }

  async refresh(oldRefreshToken: string) {
    // Verify the refresh JWT
    let payload: any;
    try {
      payload = this.jwt.verify(oldRefreshToken, {
        secret: this.config.jwtRefreshSecret,
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Look up by token hash
    const tokenHash = this.hashToken(oldRefreshToken);
    const stored = await this.usersService.findRefreshToken(tokenHash);

    if (!stored) {
      throw new UnauthorizedException('Refresh token not found');
    }

    // Replay detection: if token was already revoked, kill entire family
    if (stored.revokedAt) {
      await this.usersService.revokeTokenFamily(stored.family);
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    // Check expiration
    if (new Date(stored.expiresAt) < new Date()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    // Revoke the old token
    await this.usersService.revokeRefreshToken(stored.id);

    // Generate new token pair with the same family
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
    if (!user) {
      // No user found -- return silently to prevent email enumeration
      return;
    }

    // Generate a random token and store its SHA-256 hash
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');

    // Invalidate any existing unused reset tokens for this user
    await this.usersService.invalidateUserResets(user.id);

    // Store the hash with 1 hour expiry
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await this.usersService.createPasswordReset(user.id, tokenHash, expiresAt);

    // Build reset URL and send email
    const resetUrl = `${this.config.frontendUrl}/reset-password?token=${token}`;
    await this.mailService.sendResetEmail(user.email, resetUrl);
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    if (!newPassword || newPassword.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters long');
    }

    // Hash the submitted token to look up in DB
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const reset = await this.usersService.findPasswordReset(tokenHash);

    if (!reset) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    if (reset.usedAt) {
      throw new BadRequestException('Reset token already used');
    }

    if (new Date(reset.expiresAt) < new Date()) {
      throw new BadRequestException('Reset token expired');
    }

    // Hash the new password
    const passwordHash = await bcrypt.hash(newPassword, 12);

    // Update the user's password
    await this.usersService.updatePasswordHash(reset.userId, passwordHash);

    // Mark the token as used
    await this.usersService.markResetUsed(reset.id);

    // Revoke all refresh tokens for the user
    await this.usersService.revokeAllUserTokens(reset.userId);
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string) {
    if (!newPassword || newPassword.length < 8) {
      throw new BadRequestException('New password must be at least 8 characters long');
    }

    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new BadRequestException('User not found');
    }

    // Verify old password
    const valid = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    // Derive old encryption key
    const oldSalt = user.encryptionSalt
      ? Buffer.from(user.encryptionSalt, 'base64')
      : randomBytes(16);
    const oldKey = (await argon2.hash(oldPassword, {
      type: argon2.argon2id,
      raw: true,
      hashLength: 32,
      salt: oldSalt,
      timeCost: 3,
      memoryCost: 19456,
      parallelism: 1,
    })) as Buffer;

    // Generate new salt and derive new key
    const newSalt = randomBytes(16);
    const newSaltBase64 = newSalt.toString('base64');
    const newKey = (await argon2.hash(newPassword, {
      type: argon2.argon2id,
      raw: true,
      hashLength: 32,
      salt: newSalt,
      timeCost: 3,
      memoryCost: 19456,
      parallelism: 1,
    })) as Buffer;

    // Hash new password with bcrypt
    const newPasswordHash = await bcrypt.hash(newPassword, 12);

    // Update user: password hash, encryption salt
    await this.usersService.updatePasswordHash(userId, newPasswordHash);
    await this.usersService.updateEncryptionSalt(userId, newSaltBase64);
    const newKeyVersion = await this.usersService.incrementKeyVersion(userId);

    // Update in-memory key cache
    this.userKeyService.removeKey(userId);
    await this.userKeyService.deriveAndStore(userId, newPassword, newSalt);

    // Enqueue re-encryption job (processed by Plan 02's processor)
    await this.reencryptQueue.add('reencrypt-memories', {
      userId,
      oldKey: oldKey.toString('base64'),
      newKey: newKey.toString('base64'),
      newKeyVersion,
    });

    // Revoke all refresh tokens (force re-login with new password)
    await this.usersService.revokeAllUserTokens(userId);

    this.logger.log(`Password changed for user ${userId}, re-encryption enqueued`);
  }

  private async generateTokenPair(userId: string, email: string, family?: string) {
    const tokenFamily = family ?? randomUUID();

    // Sign access token (15min)
    const accessToken = this.jwt.sign(
      { sub: userId, email },
      {
        secret: this.config.jwtAccessSecret,
        expiresIn: this.config.jwtAccessExpiresIn as any,
        algorithm: 'HS256',
      },
    );

    // Generate refresh token: random bytes signed as JWT
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

    // Store hash of refresh token in DB
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
      createdAt: user.createdAt,
    };
  }
}
