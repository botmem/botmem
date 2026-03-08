import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
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
import { VersionController } from './version.controller';
import { HealthController } from './health.controller';
import { JwtAuthGuard } from './user-auth/jwt-auth.guard';

const isDev = process.env.NODE_ENV !== 'production';

@Module({
  controllers: [VersionController, HealthController],
  imports: [
    ...(isDev
      ? []
      : [
          ServeStaticModule.forRoot({
            rootPath: join(__dirname, '..', '..', 'web', 'dist'),
            exclude: ['/api/{*path}'],
          }),
        ]),
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
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
})
export class AppModule {}
