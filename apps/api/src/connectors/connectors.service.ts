import { Injectable } from '@nestjs/common';
import { ConnectorRegistry, BaseConnector } from '@botmem/connector-sdk';
import type { SyncSchedule } from '@botmem/connector-sdk';

@Injectable()
export class ConnectorsService {
  public readonly registry = new ConnectorRegistry();

  private normalizeId(id: string): string {
    return id === 'imessage' ? 'apple' : id;
  }

  register(factory: () => BaseConnector) {
    this.registry.register(factory);
  }

  get(id: string) {
    return this.registry.get(this.normalizeId(id));
  }

  create(id: string) {
    return this.registry.create(this.normalizeId(id));
  }

  list() {
    return this.registry.list();
  }

  getSyncConfig(id: string): { defaultSchedule: SyncSchedule; configurable: boolean } {
    const normalizedId = this.normalizeId(id);
    const sync = this.registry.has(normalizedId)
      ? this.registry.get(normalizedId).manifest.sync
      : undefined;
    return {
      defaultSchedule: sync?.defaultSchedule ?? 'daily',
      configurable: sync?.configurable ?? true,
    };
  }

  getSchema(id: string) {
    const connector = this.registry.get(this.normalizeId(id));
    return connector.manifest.configSchema;
  }
}
