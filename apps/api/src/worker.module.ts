import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { ConnectorsModule } from './connectors/connectors.module';
import { AccountsModule } from './accounts/accounts.module';
import { AuthModule } from './auth/auth.module';
import { JobsWorkerModule } from './jobs/jobs.module';
import { LogsModule } from './logs/logs.module';
import { EventsModule } from './events/events.module';
import { PluginsModule } from './plugins/plugins.module';
import { MemoryWorkerModule } from './memory/memory.module';
import { PeopleModule } from './people/people.module';
import { SettingsModule } from './settings/settings.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { MailModule } from './mail/mail.module';
import { CryptoModule } from './crypto/crypto.module';
import { BillingModule } from './billing/billing.module';
import { OAuthModule } from './oauth/oauth.module';
import { TracingModule } from './tracing/tracing.module';
import { GeoModule } from './geo/geo.module';
import { ImsgTunnelModule } from './imsg-tunnel/imsg-tunnel.module';

@Module({
  imports: [
    TracingModule,
    AnalyticsModule,
    ConfigModule,
    DbModule,
    ConnectorsModule,
    AccountsModule,
    AuthModule,
    JobsWorkerModule,
    LogsModule,
    EventsModule,
    PluginsModule,
    MemoryWorkerModule,
    PeopleModule,
    SettingsModule,
    MailModule,
    CryptoModule,
    BillingModule,
    OAuthModule,
    GeoModule,
    ImsgTunnelModule,
  ],
})
export class WorkerModule {}
