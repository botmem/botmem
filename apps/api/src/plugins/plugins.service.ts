import { Injectable, Logger } from '@nestjs/common';
import { resolve } from 'path';
import { ConnectorsService } from '../connectors/connectors.service';
import { ConfigService } from '../config/config.service';

@Injectable()
export class PluginsService {
  private readonly logger = new Logger(PluginsService.name);

  constructor(
    private connectors: ConnectorsService,
    private config: ConfigService,
  ) {}

  async loadAll() {
    // Register built-in connectors
    this.logger.log('Registering built-in connectors...');
    await this.loadBuiltin('@botmem/connector-photos-immich');
    await this.loadBuiltin('@botmem/connector-gmail');
    await this.loadBuiltin('@botmem/connector-slack');
    await this.loadBuiltin('@botmem/connector-whatsapp');
    await this.loadBuiltin('@botmem/connector-imessage');
    await this.loadBuiltin('@botmem/connector-locations');

    // Load external plugins
    const dir = resolve(this.config.pluginsDir);
    this.logger.log(`Loading external connectors from ${dir}`);
    await this.connectors.registry.loadFromDirectory(dir);

    this.logger.log(`Loaded ${this.connectors.list().length} total connectors`);
  }

  private async loadBuiltin(packageName: string) {
    try {
      const mod = await import(packageName);
      const factory = mod.default || mod.createConnector;
      if (typeof factory === 'function') {
        this.connectors.register(factory);
        this.logger.log(`Registered ${packageName}`);
      }
    } catch (err: any) {
      this.logger.warn(`Could not load ${packageName}: ${err.message}`);
    }
  }
}
