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
      throw new UnauthorizedException(
        'API keys are not accepted for MCP. Use an OAuth access token.',
      );
    }

    try {
      const allowedAudiences = this.allowedAudiences();
      const payload = this.jwtService.verify(token, {
        secret: this.config.oauthJwtSecret,
        audience: allowedAudiences,
      });

      return {
        id: payload.sub,
        scope: payload.scope || '',
        clientId: payload.client_id || '',
      };
    } catch (err: unknown) {
      throw new UnauthorizedException(
        `Invalid token: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** The base URL for the WWW-Authenticate resource_metadata hint */
  get resourceMetadataUrl(): string {
    return `${this.config.baseUrl}/.well-known/oauth-protected-resource`;
  }

  private allowedAudiences(): [string, ...string[]] {
    const configured = (process.env.MCP_ALLOWED_AUDIENCES || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const baseAudience = `${this.config.baseUrl}/mcp`;
    return [
      ...new Set([baseAudience, this.alternateBotmemAudience(baseAudience), ...configured]),
    ] as [string, ...string[]];
  }

  private alternateBotmemAudience(audience: string): string {
    try {
      const url = new URL(audience);
      // ponytail: only the known hosted apex/api pair; add MCP_ALLOWED_AUDIENCES for other deploys.
      if (url.hostname === 'botmem.xyz') url.hostname = 'api.botmem.xyz';
      else if (url.hostname === 'api.botmem.xyz') url.hostname = 'botmem.xyz';
      return url.toString().replace(/\/$/, '');
    } catch {
      return audience;
    }
  }
}
