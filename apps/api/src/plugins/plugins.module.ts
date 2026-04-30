import { Global, Module, OnModuleInit } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PluginsService } from './plugins.service';
import { PluginRegistry } from './plugin-registry';
import { ConnectorRuntimeService } from './connector-runtime.service';

@Global()
@Module({
  imports: [BullModule.registerQueue({ name: 'memory' })],
  providers: [PluginsService, PluginRegistry, ConnectorRuntimeService],
  exports: [PluginRegistry],
})
export class PluginsModule implements OnModuleInit {
  constructor(private plugins: PluginsService) {}

  async onModuleInit() {
    await this.plugins.loadAll();
  }
}
