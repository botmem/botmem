import { ForbiddenException, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { SettingsController } from '../settings.controller';
import { UpdateSettingsDto } from '../dto/update-settings.dto';
import { REQUIRES_JWT_KEY } from '../../user-auth/decorators/requires-jwt.decorator';
import { JwtAuthGuard } from '../../user-auth/jwt-auth.guard';

describe('SettingsController', () => {
  it('reads and writes settings for the current user only', async () => {
    const settingsService = {
      getAll: vi.fn().mockResolvedValue({ theme: 'dark' }),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new SettingsController(settingsService as never);

    await expect(controller.getAll({ id: 'user-1' })).resolves.toEqual({ theme: 'dark' });
    await expect(
      controller.update({ id: 'user-1' }, { settings: { theme: 'light' } }),
    ).resolves.toEqual({ theme: 'dark' });

    expect(settingsService.getAll).toHaveBeenCalledWith('user-1');
    expect(settingsService.set).toHaveBeenCalledWith('user-1', 'theme', 'light');
  });

  it('requires JWT for reads and writes so read-only API keys are rejected', async () => {
    const reflector = new Reflector();
    const guard = new JwtAuthGuard(reflector, {
      validateKey: vi.fn().mockResolvedValue({ id: 'key-1', userId: 'user-1' }),
    } as never);

    for (const handler of [
      SettingsController.prototype.getAll,
      SettingsController.prototype.update,
    ]) {
      expect(reflector.get(REQUIRES_JWT_KEY, handler)).toBe(true);
      await expect(
        guard.canActivate({
          getHandler: () => handler,
          getClass: () => SettingsController,
          switchToHttp: () => ({
            getRequest: () => ({ headers: { authorization: 'Bearer bm_sk_readonly' } }),
          }),
        } as never),
      ).rejects.toThrow(ForbiddenException);
    }
  });

  it('rejects invalid settings bodies through ValidationPipe', async () => {
    const pipe = new ValidationPipe({ whitelist: true, transform: true });

    await expect(
      pipe.transform(
        { settings: { sync_concurrency: '8' } },
        { type: 'body', metatype: UpdateSettingsDto },
      ),
    ).resolves.toEqual({ settings: { sync_concurrency: '8' } });

    await expect(
      pipe.transform(
        { settings: { 'bad-key': '8' } },
        { type: 'body', metatype: UpdateSettingsDto },
      ),
    ).rejects.toThrow();

    await expect(
      pipe.transform(
        { settings: { sync_concurrency: 8 } },
        { type: 'body', metatype: UpdateSettingsDto },
      ),
    ).rejects.toThrow();
  });
});
