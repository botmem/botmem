import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { BridgeController } from './bridge.controller';

// AppleTunnelModule is @Global and exports AppleTunnelService, so it does not
// need to be imported here.
@Module({
  imports: [ConfigModule],
  controllers: [BridgeController],
})
export class BridgeModule {}
