import { Global, Module } from '@nestjs/common';
import { ConnectorsController } from './connectors.controller';
import { ConnectorsService } from './connectors.service';
import { ConnectorSyncPolicyService } from './connector-sync-policy.service';

@Global()
@Module({
  controllers: [ConnectorsController],
  providers: [ConnectorsService, ConnectorSyncPolicyService],
  exports: [ConnectorsService, ConnectorSyncPolicyService],
})
export class ConnectorsModule {}
