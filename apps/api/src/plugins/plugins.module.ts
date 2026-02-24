import { Module, OnModuleInit } from '@nestjs/common';
import { PluginsService } from './plugins.service';

@Module({
  providers: [PluginsService],
})
export class PluginsModule implements OnModuleInit {
  constructor(private plugins: PluginsService) {}

  async onModuleInit() {
    await this.plugins.loadAll();
  }
}
