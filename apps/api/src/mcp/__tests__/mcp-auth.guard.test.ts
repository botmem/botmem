import { describe, it, expect, afterEach } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { McpAuthGuard } from '../mcp-auth.guard';
import type { ConfigService } from '../../config/config.service';

describe('McpAuthGuard', () => {
  afterEach(() => {
    delete process.env.MCP_ALLOWED_AUDIENCES;
  });

  it('accepts botmem apex and api MCP audiences', () => {
    const jwt = new JwtService();
    const guard = new McpAuthGuard(jwt, {
      baseUrl: 'https://api.botmem.xyz',
      oauthJwtSecret: 'test-secret',
    } as ConfigService);

    for (const aud of ['https://api.botmem.xyz/mcp', 'https://botmem.xyz/mcp']) {
      const token = jwt.sign(
        { sub: 'user-1', scope: 'read', client_id: 'client-1', aud },
        { secret: 'test-secret' },
      );

      expect(
        guard.validateRequest({ headers: { authorization: `Bearer ${token}` } } as never),
      ).toEqual({
        id: 'user-1',
        scope: 'read',
        clientId: 'client-1',
      });
    }
  });
});
