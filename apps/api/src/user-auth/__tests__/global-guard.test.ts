import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../jwt-auth.guard';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

describe('JwtAuthGuard (global)', () => {
  let guard: JwtAuthGuard;
  let reflector: Reflector;
  const mockApiKeysService = { validateKey: vi.fn() } as unknown as {
    validateKey: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    reflector = new Reflector();
    guard = new JwtAuthGuard(reflector, mockApiKeysService);
  });

  function mockContext(isPublic: boolean): ExecutionContext {
    const handler = () => {};
    const cls = class {};
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(isPublic);
    return {
      getHandler: () => handler,
      getClass: () => cls,
      switchToHttp: () => ({
        getRequest: () => ({ headers: {} }),
        getResponse: () => ({}),
        getNext: () => () => {},
      }),
      getType: () => 'http',
      getArgs: () => [],
      getArgByIndex: () => null,
      switchToRpc: () => ({}) as unknown as ReturnType<ExecutionContext['switchToRpc']>,
      switchToWs: () => ({}) as unknown as ReturnType<ExecutionContext['switchToWs']>,
    } as unknown as ExecutionContext;
  }

  it('should allow access to @Public() decorated routes', async () => {
    const ctx = mockContext(true);
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  it('should check IS_PUBLIC_KEY metadata', async () => {
    const ctx = mockContext(true);
    await guard.canActivate(ctx);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
  });

  it('should delegate to passport for non-public routes', async () => {
    const ctx = mockContext(false);
    // super.canActivate returns a Promise that rejects because there's
    // no passport strategy registered in the test context.
    // This confirms the guard IS delegating to passport for auth.
    await expect(guard.canActivate(ctx)).rejects.toThrow('Unknown authentication strategy "jwt"');
  });
});
