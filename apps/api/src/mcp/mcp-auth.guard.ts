import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '../config/config.service';
import type { Request } from 'express';

export interface McpUser {
  id: string;
  scope: string;
  clientId: string;
}

@Injectable()
export class McpAuthGuard {
  constructor(
    private jwtService: JwtService,
    private config: ConfigService,
  ) {}

  /**
   * Extract and verify the OAuth JWT from the Authorization header.
   * Returns the authenticated user claims or throws UnauthorizedException.
   *
   * Does NOT accept `bm_sk_*` API keys (separate auth domain).
   */
  validateRequest(req: Request): McpUser {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      throw new UnauthorizedException('Missing Authorization header');
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      throw new UnauthorizedException('Invalid Authorization header format');
    }

    const token = match[1];

    // Reject API keys — MCP uses OAuth tokens only
    if (token.startsWith('bm_sk_')) {
      throw new UnauthorizedException('API keys are not accepted for MCP. Use an OAuth access token.');
    }

    try {
      const expectedAudience = `${this.config.baseUrl}/mcp`;
      const payload = this.jwtService.verify(token, {
        secret: this.config.oauthJwtSecret,
        audience: expectedAudience,
      });

      return {
        id: payload.sub,
        scope: payload.scope || '',
        clientId: payload.client_id || '',
      };
    } catch (err: any) {
      throw new UnauthorizedException(`Invalid token: ${err.message}`);
    }
  }

  /** The base URL for the WWW-Authenticate resource_metadata hint */
  get resourceMetadataUrl(): string {
    return `${this.config.baseUrl}/.well-known/oauth-protected-resource`;
  }
}
