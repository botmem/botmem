import { Controller, Get, Req } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../user-auth/decorators/public.decorator';
import { ConfigService } from '../config/config.service';
import type { Request } from 'express';

@Controller('.well-known')
@Public()
@SkipThrottle()
export class OAuthMetadataController {
  constructor(private config: ConfigService) {}

  /** Derive the public-facing origin from the incoming request (handles proxies/ngrok). */
  private getOrigin(req: Request): string {
    if (process.env.BASE_URL) return process.env.BASE_URL;
    const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
    const host = (req.headers['x-forwarded-host'] as string) || req.headers.host;
    if (host) return `${proto}://${host}`;
    return this.config.baseUrl;
  }

  @Get('oauth-authorization-server')
  getAuthServerMetadata(@Req() req: Request) {
    const issuer = this.getOrigin(req);
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['read', 'write'],
      service_name: 'Botmem',
      service_documentation: 'https://botmem.xyz',
      logo_uri: `${issuer}/brand/logo-mark-256.png`,
    };
  }

  @Get('oauth-protected-resource')
  getProtectedResourceMetadata(@Req() req: Request) {
    const baseUrl = this.getOrigin(req);
    return {
      resource: `${baseUrl}/mcp`,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ['header'],
      scopes_supported: ['read', 'write'],
    };
  }
}
