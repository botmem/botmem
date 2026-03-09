import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { RlsInterceptor } from './db/rls.interceptor';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { existsSync } from 'fs';
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
import { ContactsModule } from './contacts/contacts.module';
import { SettingsModule } from './settings/settings.module';
import { AgentModule } from './agent/agent.module';
import { MeModule } from './me/me.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { MailModule } from './mail/mail.module';
import { UserAuthModule } from './user-auth/user-auth.module';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { MemoryBanksModule } from './memory-banks/memory-banks.module';
import { CryptoModule } from './crypto/crypto.module';
import { VersionController } from './version.controller';
import { HealthController } from './health.controller';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from './user-auth/jwt-auth.guard';

const isDev = process.env.NODE_ENV !== 'production';
const webDistPath = join(__dirname, '..', '..', 'web', 'dist');
const serveStatic = !isDev && existsSync(webDistPath);

@Module({
  controllers: [VersionController, HealthController],
  imports: [
    ...(serveStatic
      ? [
          ServeStaticModule.forRoot({
            rootPath: webDistPath,
            exclude: ['/api/{*path}'],
          }),
        ]
      : []),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60000, limit: 100 }]),
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
    ContactsModule,
    SettingsModule,
    AgentModule,
    MeModule,
    MailModule,
    UserAuthModule,
    ApiKeysModule,
    MemoryBanksModule,
    CryptoModule,
  ],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: RlsInterceptor,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
