import { Controller, Get, Post, Delete, Req, Res } from '@nestjs/common';
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
  constructor(
    private mcpService: McpService,
    private guard: McpAuthGuard,
  ) {}

  @Post()
  async handlePost(@Req() req: Request, @Res() res: Response) {
    const userId = this.authenticate(req, res);
    if (!userId) return;
    await this.mcpService.handleRequest(req, res, userId);
  }

  @Get()
  async handleGet(@Req() req: Request, @Res() res: Response) {
    const userId = this.authenticate(req, res);
    if (!userId) return;
    await this.mcpService.handleSseRequest(req, res, userId);
  }

  @Delete()
  async handleDelete(@Req() req: Request, @Res() res: Response) {
    const userId = this.authenticate(req, res);
    if (!userId) return;
    await this.mcpService.terminateSession(req, res, userId);
  }

  private authenticate(req: Request, res: Response): string | null {
    try {
      const user = this.guard.validateRequest(req);
      return user.id;
    } catch {
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
}
