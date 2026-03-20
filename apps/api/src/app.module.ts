import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { RlsInterceptor } from './db/rls.interceptor';
import { ConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { ConnectorsModule } from './connectors/connectors.module';
import { AccountsModule } from './accounts/accounts.module';
import { AuthModule } from './auth/auth.module';
import { JobsModule } from './jobs/jobs.module';
import { LogsModule } from './logs/logs.module';
import { EventsModule } from './events/events.module';
import { PluginsModule } from './plugins/plugins.module';
import { MemoryModule } from './memory/memory.module';
import { PeopleModule } from './people/people.module';
import { SettingsModule } from './settings/settings.module';
import { AgentModule } from './agent/agent.module';
import { MeModule } from './me/me.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { MailModule } from './mail/mail.module';
import { UserAuthModule } from './user-auth/user-auth.module';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { MemoryBanksModule } from './memory-banks/memory-banks.module';
import { McpModule } from './mcp/mcp.module';
import { CryptoModule } from './crypto/crypto.module';
import { BillingModule } from './billing/billing.module';
import { OAuthModule } from './oauth/oauth.module';
import { DemoModule } from './demo/demo.module';
import { PlanGuard } from './billing/plan.guard';
import { VersionController } from './version.controller';
import { HealthController } from './health.controller';
import { ThrottlerModule } from '@nestjs/throttler';
import { JwtAuthGuard } from './user-auth/jwt-auth.guard';
import { FirebaseAuthModule } from './user-auth/firebase-auth.module';
import { FirebaseAuthGuard } from './user-auth/firebase-auth.guard';
import { AuthProviderGuard } from './user-auth/auth-provider.guard';
import { WriteScopeGuard } from './user-auth/write-scope.guard';
import { TracingModule } from './tracing/tracing.module';
import { GeoModule } from './geo/geo.module';

@Module({
  controllers: [VersionController, HealthController],
  imports: [
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60000, limit: 100 }]),
    TracingModule,
    AnalyticsModule,
    ConfigModule,
    DbModule,
    ConnectorsModule,
    AccountsModule,
    AuthModule,
    JobsModule,
    LogsModule,
    EventsModule,
    PluginsModule,
    MemoryModule,
    PeopleModule,
    SettingsModule,
    AgentModule,
    MeModule,
    MailModule,
    UserAuthModule,
    ApiKeysModule,
    MemoryBanksModule,
    McpModule,
    CryptoModule,
    FirebaseAuthModule,
    BillingModule,
    OAuthModule,
    DemoModule,
    GeoModule,
  ],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: RlsInterceptor,
    },
    JwtAuthGuard,
    FirebaseAuthGuard,
    AuthProviderGuard,
    {
      provide: APP_GUARD,
      useClass: AuthProviderGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PlanGuard,
    },
    {
      provide: APP_GUARD,
      useClass: WriteScopeGuard,
    },
  ],
})
export class AppModule {}
