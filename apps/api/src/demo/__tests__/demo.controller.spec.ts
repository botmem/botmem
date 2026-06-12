import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '../../config/config.service';
import type { DbService } from '../../db/db.service';
import { IS_PUBLIC_KEY } from '../../user-auth/decorators/public.decorator';
import { DemoController } from '../demo.controller';
import type { DemoService } from '../demo.service';

function makeController(isProduction: boolean, dbOverrides: Partial<DbService['db']> = {}) {
  const db = {
    select: vi.fn(),
    execute: vi.fn(),
    ...dbOverrides,
  };
  const config = { isProduction } as ConfigService;
  const controller = new DemoController({} as DemoService, { db } as DbService, config);

  return { controller, db };
}

describe('DemoController.cleanupTestUsers', () => {
  it('refuses in production before touching the database', async () => {
    const { controller, db } = makeController(true);

    await expect(
      controller.cleanupTestUsers({ emailPattern: '%@test.botmem.xyz' }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(db.select).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('is not public', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, DemoController.prototype.cleanupTestUsers)).toBe(
      undefined,
    );
  });

  it('cleans up matching test users in non-production', async () => {
    const where = vi.fn().mockResolvedValue([{ id: 'user-1' }]);
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const execute = vi.fn().mockResolvedValue(undefined);
    const { controller } = makeController(false, { select, execute });

    await expect(
      controller.cleanupTestUsers({ emailPattern: '%@test.botmem.xyz' }),
    ).resolves.toEqual({ ok: true, deleted: 1 });

    expect(select).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });
});
