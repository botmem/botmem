import 'reflect-metadata';
import { APP_GUARD } from '@nestjs/core';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ThrottlerGuard } from '@nestjs/throttler';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { AuthProviderGuard } from '../user-auth/auth-provider.guard';
import { PlanGuard } from '../billing/plan.guard';
import { WriteScopeGuard } from '../user-auth/write-scope.guard';

describe('AppModule global guards', () => {
  it('registers ThrottlerGuard before auth, plan, and write-scope guards', () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AppModule) ?? [];
    const appGuards = providers.filter(
      (provider: { provide?: unknown }) => provider?.provide === APP_GUARD,
    );

    expect(appGuards.map((provider: { useClass?: unknown }) => provider.useClass)).toEqual([
      ThrottlerGuard,
      AuthProviderGuard,
      PlanGuard,
      WriteScopeGuard,
    ]);
  });
});
