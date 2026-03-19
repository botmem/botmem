import {
  Injectable,
  Logger,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
  OnModuleDestroy,
} from '@nestjs/common';
import Redis from 'ioredis';
import { createHash, randomBytes } from 'crypto';
import { ConfigService } from '../config/config.service';
import { UserAuthService } from './user-auth.service';
import { UsersService } from './users.service';
import { UserKeyService } from '../crypto/user-key.service';
import * as bcrypt from 'bcryptjs';

const CODE_TTL_SECONDS = 600; // 10 minutes
const SESSION_TTL_SECONDS = 600; // 10 minutes

interface CliAuthSession {
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  state: string;
}

interface CliCodeData {
  userId: string;
  email: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function validatePKCE(codeVerifier: string, codeChallenge: string): boolean {
  const computed = base64url(createHash('sha256').update(codeVerifier).digest());
  return computed === codeChallenge;
}

@Injectable()
export class CliAuthService implements OnModuleDestroy {
  private readonly logger = new Logger(CliAuthService.name);
  private redis: Redis;

  constructor(
    private config: ConfigService,
    private authService: UserAuthService,
    private usersService: UsersService,
    private userKeyService: UserKeyService,
  ) {
    this.redis = new Redis(this.config.redisUrl, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    this.redis.connect().catch((err) => {
      this.logger.warn(`Redis CLI auth connection failed: ${err.message}`);
    });
  }

  onModuleDestroy() {
    this.redis.disconnect();
  }

  /**
   * Step 1: CLI creates a pending auth session.
   * Returns a session ID + login URL for the browser.
   */
  async createSession(params: {
    codeChallenge: string;
    codeChallengeMethod: string;
    redirectUri: string;
    state: string;
  }): Promise<{ sessionId: string; loginUrl: string }> {
    const url = new URL(params.redirectUri);
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      throw new BadRequestException('CLI redirect_uri must be localhost');
    }

    const sessionId = randomBytes(32).toString('base64url');
    const session: CliAuthSession = {
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
      redirectUri: params.redirectUri,
      state: params.state,
    };

    await this.redis.set(
      `cli_auth:${sessionId}`,
      JSON.stringify(session),
      'EX',
      SESSION_TTL_SECONDS,
    );

    const loginUrl = new URL(`${this.config.frontendUrl}/cli-login`);
    loginUrl.searchParams.set('session_id', sessionId);

    return { sessionId, loginUrl: loginUrl.toString() };
  }

  /**
   * Step 2: Frontend calls this after user authenticates.
   * Validates credentials, generates auth code, returns redirect URL.
   */
  async approve(params: {
    sessionId: string;
    email: string;
    password: string;
    recoveryKey?: string;
  }): Promise<{ redirectUri: string }> {
    const raw = await this.redis.get(`cli_auth:${params.sessionId}`);
    if (!raw) {
      throw new BadRequestException('Invalid or expired CLI auth session');
    }

    const session: CliAuthSession = JSON.parse(raw);

    // Validate credentials
    const user = await this.usersService.findByEmail(params.email);
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const isFirebaseHash = user.passwordHash.startsWith('firebase:');
    if (isFirebaseHash) {
      throw new UnauthorizedException(
        'This account uses social login (Google/GitHub). Please use the social login buttons instead.',
      );
    }
    const valid = await bcrypt.compare(params.password, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    // Handle DEK / recovery key
    const existingDek = await this.userKeyService.getDek(user.id);
    if (!existingDek) {
      if (!params.recoveryKey) {
        throw new ForbiddenException('Recovery key required (encryption key not cached)');
      }
      const recoveryKeyHash = createHash('sha256').update(params.recoveryKey).digest('hex');
      if (recoveryKeyHash !== user.recoveryKeyHash) {
        throw new ForbiddenException('Invalid recovery key');
      }
      const dek = Buffer.from(params.recoveryKey, 'base64');
      await this.userKeyService.storeDek(user.id, dek);
    }

    // Generate auth code
    const code = randomBytes(48).toString('base64url');
    const codeData: CliCodeData = {
      userId: user.id,
      email: user.email,
      codeChallenge: session.codeChallenge,
      codeChallengeMethod: session.codeChallengeMethod,
      redirectUri: session.redirectUri,
    };
    await this.redis.set(`cli_code:${code}`, JSON.stringify(codeData), 'EX', CODE_TTL_SECONDS);

    // Clean up session
    await this.redis.del(`cli_auth:${params.sessionId}`);

    // Build redirect URL
    const redirectUrl = new URL(session.redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (session.state) {
      redirectUrl.searchParams.set('state', session.state);
    }

    this.logger.log(`CLI auth approved for user ${user.email}`);
    return { redirectUri: redirectUrl.toString() };
  }

  /**
   * Step 2b: Approve using an existing JWT session (no password needed).
   */
  async approveWithToken(params: {
    sessionId: string;
    userId: string;
    email: string;
    recoveryKey?: string;
  }): Promise<{ redirectUri: string }> {
    const raw = await this.redis.get(`cli_auth:${params.sessionId}`);
    if (!raw) {
      throw new BadRequestException('Invalid or expired CLI auth session');
    }

    const session: CliAuthSession = JSON.parse(raw);

    // Handle DEK / recovery key
    const existingDek = await this.userKeyService.getDek(params.userId);
    if (!existingDek) {
      if (!params.recoveryKey) {
        throw new ForbiddenException('Recovery key required (encryption key not cached)');
      }
      const user = await this.usersService.findById(params.userId);
      if (!user) throw new UnauthorizedException('User not found');
      const recoveryKeyHash = createHash('sha256').update(params.recoveryKey).digest('hex');
      if (recoveryKeyHash !== user.recoveryKeyHash) {
        throw new ForbiddenException('Invalid recovery key');
      }
      const dek = Buffer.from(params.recoveryKey, 'base64');
      await this.userKeyService.storeDek(params.userId, dek);
    }

    // Generate auth code
    const code = randomBytes(48).toString('base64url');
    const codeData: CliCodeData = {
      userId: params.userId,
      email: params.email,
      codeChallenge: session.codeChallenge,
      codeChallengeMethod: session.codeChallengeMethod,
      redirectUri: session.redirectUri,
    };
    await this.redis.set(`cli_code:${code}`, JSON.stringify(codeData), 'EX', CODE_TTL_SECONDS);

    // Clean up session
    await this.redis.del(`cli_auth:${params.sessionId}`);

    // Build redirect URL
    const redirectUrl = new URL(session.redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (session.state) {
      redirectUrl.searchParams.set('state', session.state);
    }

    this.logger.log(`CLI auth approved (via token) for user ${params.email}`);
    return { redirectUri: redirectUrl.toString() };
  }

  /**
   * Step 3: CLI exchanges auth code + PKCE verifier for user-auth JWT tokens.
   */
  async exchangeCode(params: { code: string; codeVerifier: string; redirectUri: string }): Promise<{
    accessToken: string;
    refreshToken: string;
    user: { id: string; email: string; name: string };
  }> {
    const raw = await this.redis.get(`cli_code:${params.code}`);
    if (!raw) {
      throw new BadRequestException('Invalid or expired authorization code');
    }

    const codeData: CliCodeData = JSON.parse(raw);

    if (codeData.redirectUri !== params.redirectUri) {
      throw new BadRequestException('Redirect URI mismatch');
    }

    if (!validatePKCE(params.codeVerifier, codeData.codeChallenge)) {
      throw new BadRequestException('Invalid code verifier (PKCE validation failed)');
    }

    // Consume the code (one-time use)
    await this.redis.del(`cli_code:${params.code}`);

    // Issue standard user-auth tokens
    const tokens = await this.authService.generateTokensForUser(codeData.userId, codeData.email);

    const user = await this.usersService.findById(codeData.userId);

    this.logger.log(`CLI token issued for user ${codeData.email}`);
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: codeData.userId,
        email: codeData.email,
        name: user?.name ?? '',
      },
    };
  }
}
