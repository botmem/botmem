import { Global, Module, OnModuleInit } from '@nestjs/common';
import { PluginsService } from './plugins.service';
import { PluginRegistry } from './plugin-registry';

@Global()
@Module({
  providers: [PluginsService, PluginRegistry],
  exports: [PluginRegistry],
})
export class PluginsModule implements OnModuleInit {
  constructor(private plugins: PluginsService) {}

  async onModuleInit() {
    await this.plugins.loadAll();
  }
}
