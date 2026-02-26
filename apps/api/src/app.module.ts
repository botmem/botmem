import { Module } from '@nestjs/common';
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
import { VersionController } from './version.controller';

const isDev = process.env.NODE_ENV !== 'production';

@Module({
  controllers: [VersionController],
  imports: [
    ...(isDev
      ? []
      : [
          ServeStaticModule.forRoot({
            rootPath: join(__dirname, '..', '..', 'web', 'dist'),
            exclude: ['/api/{*path}'],
          }),
        ]),
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
  ],
})
export class AppModule {}
