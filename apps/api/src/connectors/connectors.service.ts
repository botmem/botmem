import { Injectable } from '@nestjs/common';
import { ConnectorRegistry, BaseConnector } from '@botmem/connector-sdk';

@Injectable()
export class ConnectorsService {
  public readonly registry = new ConnectorRegistry();

  register(factory: () => BaseConnector) {
    this.registry.register(factory);
  }

  get(id: string) {
    return this.registry.get(id);
  }

  list() {
    return this.registry.list();
  }

  getSchema(id: string) {
    const connector = this.registry.get(id);
    return connector.manifest.configSchema;
  }
}
