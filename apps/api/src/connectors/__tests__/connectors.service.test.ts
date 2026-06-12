import { describe, it, expect } from 'vitest';
import { ConnectorsService } from '../connectors.service';
import { BaseConnector } from '@botmem/connector-sdk';
import type {
  ConnectorManifest,
  AuthContext,
  AuthInitResult,
  SyncResult,
} from '@botmem/connector-sdk';

class FakeConnector extends BaseConnector {
  readonly manifest: ConnectorManifest = {
    id: 'fake',
    name: 'Fake',
    description: 'Fake connector',
    color: '#000',
    icon: 'test',
    authType: 'api-key',
    configSchema: { type: 'object', properties: { key: { type: 'string' } } },
    entities: ['person'],
    pipeline: { clean: true, embed: true, enrich: true },
    trustScore: 0.7,
  };
  async initiateAuth(): Promise<AuthInitResult> {
    return { type: 'complete', auth: {} };
  }
  async completeAuth(): Promise<AuthContext> {
    return {};
  }
  async validateAuth(): Promise<boolean> {
    return true;
  }
  async revokeAuth(): Promise<void> {}
  async sync(): Promise<SyncResult> {
    return { cursor: null, hasMore: false, processed: 0 };
  }
}

class ManagedSyncConnector extends FakeConnector {
  readonly manifest: ConnectorManifest = {
    id: 'managed',
    name: 'Managed',
    description: 'Managed sync connector',
    color: '#000',
    icon: 'test',
    authType: 'api-key',
    configSchema: { type: 'object', properties: { key: { type: 'string' } } },
    entities: ['person'],
    pipeline: { clean: true, embed: true, enrich: true },
    trustScore: 0.7,
    sync: { defaultSchedule: 'manual', configurable: false },
  };
}

class AppleConnector extends FakeConnector {
  readonly manifest: ConnectorManifest = { ...new FakeConnector().manifest, id: 'apple' };
}

class PhotosConnector extends FakeConnector {
  readonly manifest: ConnectorManifest = { ...new FakeConnector().manifest, id: 'photos' };
}

describe('ConnectorsService', () => {
  it('registers and gets a connector', () => {
    const service = new ConnectorsService();
    service.register(() => new FakeConnector());
    const connector = service.get('fake');
    expect(connector.manifest.id).toBe('fake');
  });

  it('creates fresh connector instances so sync listeners cannot bleed across accounts', () => {
    const service = new ConnectorsService();
    service.register(() => new FakeConnector());

    const first = service.create('fake');
    const second = service.create('fake');

    expect(first).not.toBe(second);
    expect(first).not.toBe(service.get('fake'));
    expect(second).not.toBe(service.get('fake'));
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

  it('returns SDK manifest sync config with daily configurable defaults', () => {
    const service = new ConnectorsService();
    service.register(() => new FakeConnector());
    service.register(() => new ManagedSyncConnector());

    expect(service.getSyncConfig('fake')).toEqual({
      defaultSchedule: 'daily',
      configurable: true,
    });
    expect(service.getSyncConfig('managed')).toEqual({
      defaultSchedule: 'manual',
      configurable: false,
    });
    expect(service.getSyncConfig('unknown')).toEqual({
      defaultSchedule: 'daily',
      configurable: true,
    });
  });

  it('maps legacy connector ids to canonical connectors', () => {
    const service = new ConnectorsService();
    service.register(() => new AppleConnector());
    service.register(() => new PhotosConnector());

    expect(service.get('imessage').manifest.id).toBe('apple');
    expect(service.get('photos-immich').manifest.id).toBe('photos');
  });

  it('exposes registry', () => {
    const service = new ConnectorsService();
    expect(service.registry).toBeDefined();
    expect(service.registry.list()).toEqual([]);
  });
});
