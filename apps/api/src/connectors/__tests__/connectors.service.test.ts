import { describe, it, expect } from 'vitest';
import { ConnectorsService } from '../connectors.service';
import { BaseConnector } from '@botmem/connector-sdk';
import type { ConnectorManifest, AuthContext, AuthInitResult, SyncContext, SyncResult } from '@botmem/connector-sdk';

class FakeConnector extends BaseConnector {
  readonly manifest: ConnectorManifest = {
    id: 'fake', name: 'Fake', description: 'Fake connector',
    color: '#000', icon: 'test', authType: 'api-key',
    configSchema: { type: 'object', properties: { key: { type: 'string' } } },
  };
  async initiateAuth(): Promise<AuthInitResult> { return { type: 'complete', auth: {} }; }
  async completeAuth(): Promise<AuthContext> { return {}; }
  async validateAuth(): Promise<boolean> { return true; }
  async revokeAuth(): Promise<void> {}
  async sync(): Promise<SyncResult> { return { cursor: null, hasMore: false, processed: 0 }; }
}

describe('ConnectorsService', () => {
  it('registers and gets a connector', () => {
    const service = new ConnectorsService();
    service.register(() => new FakeConnector());
    const connector = service.get('fake');
    expect(connector.manifest.id).toBe('fake');
  });

  it('lists registered connectors', () => {
    const service = new ConnectorsService();
    service.register(() => new FakeConnector());
    const list = service.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('fake');
  });

  it('throws for unknown connector', () => {
    const service = new ConnectorsService();
    expect(() => service.get('unknown')).toThrow('not found');
  });

  it('returns schema for connector', () => {
    const service = new ConnectorsService();
    service.register(() => new FakeConnector());
    const schema = service.getSchema('fake');
    expect(schema).toEqual({ type: 'object', properties: { key: { type: 'string' } } });
  });

  it('exposes registry', () => {
    const service = new ConnectorsService();
    expect(service.registry).toBeDefined();
    expect(service.registry.list()).toEqual([]);
  });
});
