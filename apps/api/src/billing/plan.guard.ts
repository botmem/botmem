import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRES_PRO_KEY } from './requires-pro.decorator';
import { BillingService } from './billing.service';
import { ConfigService } from '../config/config.service';

@Injectable()
export class PlanGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private billingService: BillingService,
    private config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiresPro = this.reflector.getAllAndOverride<boolean>(REQUIRES_PRO_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiresPro) return true;
    if (this.config.isSelfHosted) return true;

    const request = context.switchToHttp().getRequest();
    const userId = request.user?.id;
    if (!userId) throw new ForbiddenException('Authentication required');

    const isPro = await this.billingService.isProUser(userId);
    if (!isPro) throw new ForbiddenException('Pro subscription required');

    return true;
  }
}
