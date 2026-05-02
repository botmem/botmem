import { Controller, Get, Post, Delete, Logger, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../user-auth/decorators/public.decorator';
import { McpService } from './mcp.service';
import { McpAuthGuard } from './mcp-auth.guard';
import type { Request, Response } from 'express';

@ApiTags('MCP')
@Controller('mcp')
@Public() // Handles its own auth via McpAuthGuard
@SkipThrottle()
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(
    private mcpService: McpService,
    private guard: McpAuthGuard,
  ) {}

  @Post()
  async handlePost(@Req() req: Request, @Res() res: Response) {
    const user = this.authenticate(req, res);
    if (!user) return;
    await this.mcpService.handleRequest(req, res, user.id);
  }

  @Get()
  async handleGet(@Req() req: Request, @Res() res: Response) {
    const user = this.authenticate(req, res);
    if (!user) return;
    this.mcpService.handleSseStream(req, res, user.id, user.clientId);
  }

  @Delete()
  async handleDelete(@Req() req: Request, @Res() res: Response) {
    const user = this.authenticate(req, res);
    if (!user) return;
    await this.mcpService.terminateSession(req, res, user.id);
  }

  private authenticate(req: Request, res: Response): { id: string; clientId: string } | null {
    try {
      const user = this.guard.validateRequest(req);
      return user;
    } catch (err: unknown) {
      this.logger.warn(
        JSON.stringify({
          event: 'mcp.auth_failed',
          method: req.method,
          path: req.originalUrl,
          reason: this.authFailureReason(err),
        }),
      );
      // Derive public origin from request headers (handles ngrok/proxies)
      const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
      const host = (req.headers['x-forwarded-host'] as string) || req.headers.host;
      const origin = process.env.BASE_URL || (host ? `${proto}://${host}` : '');
      const resourceUrl = `${origin}/.well-known/oauth-protected-resource`;
      res
        .status(401)
        .setHeader('WWW-Authenticate', `Bearer resource_metadata="${resourceUrl}"`)
        .json({ error: 'unauthorized' });
      return null;
    }
  }

  private authFailureReason(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Missing Authorization')) return 'missing_authorization';
    if (message.includes('API keys are not accepted')) return 'api_key_rejected';
    if (message.includes('audience')) return 'audience_mismatch';
    if (message.includes('Invalid Authorization')) return 'invalid_authorization_header';
    return 'invalid_token';
  }
}
