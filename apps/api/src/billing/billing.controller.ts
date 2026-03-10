import {
  Controller,
  Post,
  Get,
  Req,
  Res,
  BadRequestException,
  Logger,
  Headers,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../user-auth/decorators/public.decorator';
import { CurrentUser } from '../user-auth/decorators/current-user.decorator';
import { BillingService } from './billing.service';
import { ConfigService } from '../config/config.service';
import Stripe from 'stripe';
import type { Request, Response } from 'express';

@Controller('billing')
export class BillingController {
  private readonly logger = new Logger(BillingController.name);
  private stripe: Stripe | null = null;

  constructor(
    private billingService: BillingService,
    private config: ConfigService,
  ) {
    if (!this.config.isSelfHosted) {
      this.stripe = new Stripe(this.config.stripeSecretKey);
    }
  }

  @Post('checkout')
  async createCheckout(@CurrentUser() user: { id: string; email: string }) {
    if (this.config.isSelfHosted) {
      throw new BadRequestException('Billing not available in self-hosted mode');
    }
    return this.billingService.createCheckoutSession(user.id, user.email);
  }

  @Post('portal')
  async createPortal(@CurrentUser() user: { id: string; email: string }) {
    if (this.config.isSelfHosted) {
      throw new BadRequestException('Billing not available in self-hosted mode');
    }
    return this.billingService.createPortalSession(user.id);
  }

  @Get('info')
  async getBillingInfo(@CurrentUser() user: { id: string }) {
    if (this.config.isSelfHosted) {
      return { enabled: false };
    }
    const info = await this.billingService.getBillingInfo(user.id);
    return { enabled: true, ...info };
  }

  @Public()
  @SkipThrottle()
  @Post('webhook')
  async handleWebhook(
    @Req() req: Request,
    @Res() res: Response,
    @Headers('stripe-signature') signature: string,
  ) {
    if (this.config.isSelfHosted || !this.stripe) {
      return res.status(400).json({ error: 'Billing not available' });
    }

    const rawBody = (req as any).rawBody;
    if (!rawBody) {
      this.logger.error('Raw body not available for webhook verification');
      return res.status(400).json({ error: 'Raw body not available' });
    }

    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.config.stripeWebhookSecret,
      );
    } catch (err: unknown) {
      this.logger.warn(
        `Webhook signature verification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return res.status(400).json({ error: 'Invalid signature' });
    }

    await this.billingService.handleWebhookEvent(event);
    return res.json({ received: true });
  }
}
