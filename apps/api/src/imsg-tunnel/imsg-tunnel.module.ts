import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { DbModule } from '../db/db.module';
import { CryptoModule } from '../crypto/crypto.module';
import { ImsgTunnelService } from './imsg-tunnel.service';
import { ImsgTunnelGateway } from './imsg-tunnel.gateway';

@Module({
  imports: [ConfigModule, DbModule, CryptoModule],
  providers: [ImsgTunnelService, ImsgTunnelGateway],
  exports: [ImsgTunnelService],
})
export class ImsgTunnelModule {}
