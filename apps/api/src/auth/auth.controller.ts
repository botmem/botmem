import { Controller, Post, Get, Param, Body, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { AuthService } from './auth.service';
import { ConfigService } from '../config/config.service';
import { Public } from '../user-auth/decorators/public.decorator';
import { CurrentUser } from '../user-auth/decorators/current-user.decorator';

@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private config: ConfigService,
  ) {}

  @Get(':type/has-credentials')
  async hasCredentials(@Param('type') type: string) {
    const saved = await this.authService.getSavedCredentials(type);
    // In Firebase mode, server-side creds count as "saved"
    if (!saved && this.config.authProvider === 'firebase' && type === 'gmail') {
      return { hasSavedCredentials: !!this.config.gmailClientId };
    }
    return { hasSavedCredentials: !!saved };
  }

  @Post(':type/initiate')
  async initiate(
    @CurrentUser() user: { id: string },
    @Param('type') type: string,
    @Body() body: { config: Record<string, unknown> },
  ) {
    return this.authService.initiate(type, body.config || {}, user.id);
  }

  @Public()
  @Get(':type/callback')
  async callback(
    @Param('type') type: string,
    @Query() query: Record<string, string>,
    @Res() res: Response,
  ) {
    try {
      const { returnTo } = await this.authService.handleCallback(type, query);
      const target = returnTo
        ? `${this.config.frontendUrl}${returnTo}`
        : `${this.config.frontendUrl}/connectors`;
      res.redirect(`${target}?auth=success&type=${type}`);
    } catch (err: any) {
      const msg = encodeURIComponent(err?.message || 'Unknown error');
      res.redirect(`${this.config.frontendUrl}/connectors?auth=error&type=${type}&error=${msg}`);
    }
  }

  @Post(':type/complete')
  async complete(
    @CurrentUser() user: { id: string },
    @Param('type') type: string,
    @Body() body: { accountId?: string; params: Record<string, unknown> },
  ) {
    return this.authService.complete(type, body, user.id);
  }

  @Post(':type/reauth/:accountId')
  async reauth(
    @Param('type') type: string,
    @Param('accountId') accountId: string,
    @Body() body: { config: Record<string, unknown> },
  ) {
    return this.authService.reauth(type, accountId, body.config || {});
  }
}
