import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlanGuard } from '../plan.guard';
import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';

describe('PlanGuard', () => {
  let guard: PlanGuard;
  let reflector: any;
  let billingService: any;
  let config: any;

  function createContext(userId?: string): ExecutionContext {
    return {
      getHandler: vi.fn(),
      getClass: vi.fn(),
      switchToHttp: vi.fn().mockReturnValue({
        getRequest: vi.fn().mockReturnValue({
          user: userId ? { id: userId } : undefined,
        }),
      }),
    } as any;
  }

  beforeEach(() => {
    reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(false),
    };
    billingService = {
      isProUser: vi.fn().mockResolvedValue(false),
    };
    config = { isSelfHosted: false };
    guard = new PlanGuard(reflector, billingService, config as any);
  });

  it('allows access when @RequiresPro is not set', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    const ctx = createContext('user-1');

    expect(await guard.canActivate(ctx)).toBe(true);
    expect(billingService.isProUser).not.toHaveBeenCalled();
  });

  it('allows access when @RequiresPro is undefined', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    const ctx = createContext('user-1');

    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it('allows access in self-hosted mode even with @RequiresPro', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    config.isSelfHosted = true;
    guard = new PlanGuard(reflector, billingService, config as any);
    const ctx = createContext('user-1');

    expect(await guard.canActivate(ctx)).toBe(true);
    expect(billingService.isProUser).not.toHaveBeenCalled();
  });

  it('throws ForbiddenException when no userId', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    const ctx = createContext(undefined);

    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    await expect(guard.canActivate(ctx)).rejects.toThrow('Authentication required');
  });

  it('throws ForbiddenException when user is not pro', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    billingService.isProUser.mockResolvedValue(false);
    const ctx = createContext('user-1');

    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    await expect(guard.canActivate(ctx)).rejects.toThrow('Pro subscription required');
  });

  it('allows access when user is pro', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    billingService.isProUser.mockResolvedValue(true);
    const ctx = createContext('user-1');

    expect(await guard.canActivate(ctx)).toBe(true);
    expect(billingService.isProUser).toHaveBeenCalledWith('user-1');
  });

  it('passes correct metadata key to reflector', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    const ctx = createContext('user-1');

    await guard.canActivate(ctx);

    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(
      'requiresPro',
      [ctx.getHandler(), ctx.getClass()],
    );
  });
});
