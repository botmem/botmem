import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { DbModule } from '../db/db.module';
import { CryptoModule } from '../crypto/crypto.module';
import { AppleTunnelService } from './apple-tunnel.service';
import { AppleTunnelGateway } from './apple-tunnel.gateway';

@Global()
@Module({
  imports: [ConfigModule, DbModule, CryptoModule],
  providers: [AppleTunnelService, AppleTunnelGateway],
  exports: [AppleTunnelService],
})
export class AppleTunnelModule {}
