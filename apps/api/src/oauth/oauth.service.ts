import { Injectable, Logger, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { eq, and, isNull } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { ConfigService } from '../config/config.service';
import { oauthClients, oauthCodes, oauthRefreshTokens } from '../db/schema';

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function validatePKCE(codeVerifier: string, codeChallenge: string): boolean {
  const computed = base64url(createHash('sha256').update(codeVerifier).digest());
  return computed === codeChallenge;
}

@Injectable()
export class OAuthService {
  private readonly logger = new Logger(OAuthService.name);

  constructor(
    private db: DbService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  async registerClient(name: string, redirectUris: string[], grantTypes?: string[]) {
    const clientId = randomUUID();
    const grants = grantTypes ?? ['authorization_code', 'refresh_token'];

    await this.db.db.insert(oauthClients).values({
      clientId,
      clientName: name,
      redirectUris: JSON.stringify(redirectUris),
      grantTypes: JSON.stringify(grants),
      scope: 'read write',
    });

    return {
      client_id: clientId,
      client_name: name,
      redirect_uris: redirectUris,
      grant_types: grants,
    };
  }

  async getClient(clientId: string) {
    const rows = await this.db.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId))
      .limit(1);
    return rows[0] ?? null;
  }

  async generateAuthCode(
    userId: string,
    clientId: string,
    redirectUri: string,
    scope: string,
    codeChallenge: string,
    codeChallengeMethod = 'S256',
  ): Promise<string> {
    const code = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await this.db.db.insert(oauthCodes).values({
      code,
      userId,
      clientId,
      redirectUri,
      scope,
      codeChallenge,
      codeChallengeMethod,
      expiresAt,
    });

    return code;
  }

  async validateAndConsumeCode(
    code: string,
    clientId: string,
    redirectUri: string,
    codeVerifier: string,
  ): Promise<{ userId: string; scope: string }> {
    const rows = await this.db.db
      .select()
      .from(oauthCodes)
      .where(eq(oauthCodes.code, code))
      .limit(1);

    const codeRow = rows[0];
    if (!codeRow) {
      throw new BadRequestException('Invalid authorization code');
    }

    if (codeRow.usedAt) {
      throw new BadRequestException('Authorization code already used');
    }

    if (new Date(codeRow.expiresAt) < new Date()) {
      throw new BadRequestException('Authorization code expired');
    }

    if (codeRow.clientId !== clientId) {
      throw new BadRequestException('Client ID mismatch');
    }

    if (codeRow.redirectUri !== redirectUri) {
      throw new BadRequestException('Redirect URI mismatch');
    }

    // PKCE S256 validation
    if (!validatePKCE(codeVerifier, codeRow.codeChallenge)) {
      throw new BadRequestException('Invalid code verifier (PKCE validation failed)');
    }

    // Mark code as used
    await this.db.db
      .update(oauthCodes)
      .set({ usedAt: new Date() })
      .where(eq(oauthCodes.code, code));

    return { userId: codeRow.userId, scope: codeRow.scope };
  }

  async issueTokens(
    userId: string,
    scope: string,
    clientId: string,
  ): Promise<{
    access_token: string;
    token_type: string;
    expires_in: number;
    refresh_token: string;
    scope: string;
  }> {
    const baseUrl = this.config.baseUrl;

    const accessToken = this.jwt.sign(
      {
        iss: baseUrl,
        sub: userId,
        aud: `${baseUrl}/mcp`,
        scope,
        client_id: clientId,
      },
      {
        secret: this.config.oauthJwtSecret,
        expiresIn: 3600,
        algorithm: 'HS256',
      },
    );

    // Generate refresh token
    const refreshTokenRaw = randomBytes(48).toString('base64url');
    const tokenHash = createHash('sha256').update(refreshTokenRaw).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await this.db.db.insert(oauthRefreshTokens).values({
      id: randomUUID(),
      tokenHash,
      userId,
      clientId,
      scope,
      expiresAt,
    });

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refreshTokenRaw,
      scope,
    };
  }

  async refreshTokens(
    refreshToken: string,
    clientId: string,
  ): Promise<{
    access_token: string;
    token_type: string;
    expires_in: number;
    refresh_token: string;
    scope: string;
  }> {
    const tokenHash = createHash('sha256').update(refreshToken).digest('hex');

    const rows = await this.db.db
      .select()
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.tokenHash, tokenHash))
      .limit(1);

    const stored = rows[0];
    if (!stored) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (stored.revokedAt) {
      throw new UnauthorizedException('Refresh token revoked');
    }

    if (new Date(stored.expiresAt) < new Date()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    if (stored.clientId !== clientId) {
      throw new UnauthorizedException('Client ID mismatch');
    }

    // Revoke old token
    await this.db.db
      .update(oauthRefreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(oauthRefreshTokens.id, stored.id));

    // Issue new pair
    return this.issueTokens(stored.userId, stored.scope, clientId);
  }

  async revokeToken(token: string): Promise<void> {
    const tokenHash = createHash('sha256').update(token).digest('hex');

    await this.db.db
      .update(oauthRefreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(oauthRefreshTokens.tokenHash, tokenHash), isNull(oauthRefreshTokens.revokedAt)),
      );
  }

  verifyAccessToken(token: string): Record<string, unknown> {
    try {
      const payload = this.jwt.verify(token, {
        secret: this.config.oauthJwtSecret,
        algorithms: ['HS256'],
      });

      const expectedAud = `${this.config.baseUrl}/mcp`;
      if (payload.aud !== expectedAud) {
        throw new UnauthorizedException('Invalid token audience');
      }

      return payload;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
}
