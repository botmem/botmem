import { Module } from '@nestjs/common';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { ConfigModule } from '../config/config.module';
import { TypesenseService } from '../memory/typesense.service';
import { ImsgTunnelModule } from '../imsg-tunnel/imsg-tunnel.module';

@Module({
  imports: [ConfigModule, ImsgTunnelModule],
  controllers: [AccountsController],
  providers: [AccountsService, TypesenseService],
  exports: [AccountsService],
})
export class AccountsModule {}
