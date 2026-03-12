import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Req,
  Res,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { Response } from 'express';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Public } from '../user-auth/decorators/public.decorator';
import { OAuthService } from './oauth.service';
import { UsersService } from '../user-auth/users.service';
import { FirebaseAuthService } from '../user-auth/firebase-auth.service';
import { UserKeyService } from '../crypto/user-key.service';
import { ConfigService } from '../config/config.service';

@ApiTags('OAuth')
@ApiBearerAuth()
@Controller('oauth')
export class OAuthController {
  private readonly logger = new Logger(OAuthController.name);

  constructor(
    private oauthService: OAuthService,
    private usersService: UsersService,
    private firebaseAuthService: FirebaseAuthService,
    private userKeyService: UserKeyService,
    private jwtService: JwtService,
    private config: ConfigService,
  ) {}

  @Get('client-info')
  @Public()
  async clientInfo(@Query('client_id') clientId: string) {
    if (!clientId) throw new BadRequestException('client_id is required');
    const client = await this.oauthService.getClient(clientId);
    if (!client) throw new BadRequestException('Unknown client');
    return { client_id: client.clientId, client_name: client.clientName };
  }

  @Post('register')
  @Public()
  async register(
    @Body() body: { client_name: string; redirect_uris: string[]; grant_types?: string[] },
  ) {
    if (!body.client_name || !body.redirect_uris?.length) {
      throw new BadRequestException('client_name and redirect_uris are required');
    }

    return this.oauthService.registerClient(body.client_name, body.redirect_uris, body.grant_types);
  }

  @Get('authorize')
  @Public()
  async authorize(
    @Req() req: Request,
    @Query('client_id') clientId: string,
    @Query('redirect_uri') redirectUri: string,
    @Query('response_type') responseType: string,
    @Query('scope') scope: string,
    @Query('state') state: string,
    @Query('code_challenge') codeChallenge: string,
    @Query('code_challenge_method') codeChallengeMethod: string,
    @Res() res: Response,
  ) {
    if (responseType !== 'code') {
      throw new BadRequestException('response_type must be "code"');
    }

    if (!codeChallenge || codeChallengeMethod !== 'S256') {
      throw new BadRequestException('PKCE with S256 is required');
    }

    const client = await this.oauthService.getClient(clientId);
    if (!client) {
      throw new BadRequestException('Invalid client_id');
    }

    const allowedUris: string[] = JSON.parse(client.redirectUris);
    if (!allowedUris.includes(redirectUri)) {
      throw new BadRequestException('Invalid redirect_uri');
    }

    const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
    const host = (req.headers['x-forwarded-host'] as string) || req.headers.host;
    const origin = process.env.BASE_URL || (host ? `${proto}://${host}` : this.config.frontendUrl);
    const consentUrl = new URL(`${origin}/oauth/consent`);
    consentUrl.searchParams.set('client_id', clientId);
    consentUrl.searchParams.set('scope', scope || 'read write');
    consentUrl.searchParams.set('state', state || '');
    consentUrl.searchParams.set('code_challenge', codeChallenge);
    consentUrl.searchParams.set('code_challenge_method', codeChallengeMethod);
    consentUrl.searchParams.set('redirect_uri', redirectUri);

    return res.redirect(302, consentUrl.toString());
  }

  @Post('authorize/complete')
  @Public()
  async authorizeComplete(
    @Req() req: Request,
    @Body()
    body: {
      email?: string;
      password?: string;
      recoveryKey?: string;
      clientId: string;
      scope: string;
      state: string;
      codeChallenge: string;
      codeChallengeMethod: string;
      redirectUri: string;
    },
  ) {
    const {
      email,
      password,
      recoveryKey,
      clientId,
      scope,
      state,
      codeChallenge,
      codeChallengeMethod,
      redirectUri,
    } = body;

    // Validate client
    const client = await this.oauthService.getClient(clientId);
    if (!client) {
      throw new BadRequestException('Invalid client_id');
    }

    const allowedUris: string[] = JSON.parse(client.redirectUris);
    if (!allowedUris.includes(redirectUri)) {
      throw new BadRequestException('Invalid redirect_uri');
    }

    // Authenticate: Bearer token (existing session) or email/password
    let user: Awaited<ReturnType<typeof this.usersService.findById>> | null = null;
    const bearerMatch = req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
    if (bearerMatch) {
      const token = bearerMatch[1];
      // Try native JWT first
      try {
        const payload = this.jwtService.verify(token, {
          secret: this.config.jwtAccessSecret,
        });
        user = await this.usersService.findById(payload.sub);
      } catch {
        // If native JWT fails and Firebase is enabled, try Firebase ID token
        if (this.config.authProvider === 'firebase') {
          try {
            const decoded = await this.firebaseAuthService.verifyIdToken(token);
            const result = await this.firebaseAuthService.findOrCreateUser(decoded);
            user = result.user;
          } catch {
            throw new UnauthorizedException('Invalid session token');
          }
        } else {
          throw new UnauthorizedException('Invalid session token');
        }
      }
    } else if (email && password) {
      user = await this.usersService.findByEmail(email);
      if (!user) throw new UnauthorizedException('Invalid credentials');
      const passwordValid = await bcrypt.compare(password, user.passwordHash);
      if (!passwordValid) throw new UnauthorizedException('Invalid credentials');
    } else {
      throw new UnauthorizedException('Provide email/password or Authorization header');
    }

    if (!user) throw new UnauthorizedException('User not found');

    // If DEK is already cached (from a previous login), skip recovery key
    const existingDek = await this.userKeyService.getDek(user.id);
    if (!existingDek) {
      // DEK not cached — recovery key is required
      if (!recoveryKey) {
        throw new ForbiddenException('Recovery key is required (encryption key not cached)');
      }
      const recoveryKeyHash = createHash('sha256').update(recoveryKey).digest('hex');
      if (recoveryKeyHash !== user.recoveryKeyHash) {
        throw new ForbiddenException('Invalid recovery key');
      }
      const dek = Buffer.from(recoveryKey, 'base64');
      await this.userKeyService.storeDek(user.id, dek);
    }

    // Generate auth code
    const code = await this.oauthService.generateAuthCode(
      user.id,
      clientId,
      redirectUri,
      scope || 'read write',
      codeChallenge,
      codeChallengeMethod || 'S256',
    );

    const finalRedirect = new URL(redirectUri);
    finalRedirect.searchParams.set('code', code);
    if (state) {
      finalRedirect.searchParams.set('state', state);
    }

    return { redirect_uri: finalRedirect.toString() };
  }

  @Post('token')
  @Public()
  async token(
    @Body()
    body: {
      grant_type: string;
      code?: string;
      code_verifier?: string;
      redirect_uri?: string;
      client_id: string;
      refresh_token?: string;
    },
  ) {
    const { grant_type, code, code_verifier, redirect_uri, client_id, refresh_token } = body;

    if (grant_type === 'authorization_code') {
      if (!code || !code_verifier || !redirect_uri || !client_id) {
        throw new BadRequestException(
          'code, code_verifier, redirect_uri, and client_id are required',
        );
      }

      const { userId, scope } = await this.oauthService.validateAndConsumeCode(
        code,
        client_id,
        redirect_uri,
        code_verifier,
      );

      return this.oauthService.issueTokens(userId, scope, client_id);
    }

    if (grant_type === 'refresh_token') {
      if (!refresh_token || !client_id) {
        throw new BadRequestException('refresh_token and client_id are required');
      }

      return this.oauthService.refreshTokens(refresh_token, client_id);
    }

    throw new BadRequestException('Unsupported grant_type');
  }

  @Post('revoke')
  @Public()
  async revoke(@Body() body: { token: string }) {
    if (!body.token) {
      throw new BadRequestException('token is required');
    }

    await this.oauthService.revokeToken(body.token);
    return { status: 'ok' };
  }
}
