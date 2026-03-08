import { describe, it, expect } from 'vitest';
import { ConnectorRegistry } from '../registry.js';
import { BaseConnector } from '../base.js';
import type { ConnectorManifest, AuthContext, AuthInitResult, SyncResult } from '../types.js';

class TestConnector extends BaseConnector {
  readonly manifest: ConnectorManifest;

  constructor(id: string, name: string) {
    super();
    this.manifest = {
      id,
      name,
      description: `${name} connector`,
      color: '#000',
      icon: 'test',
      authType: 'api-key',
      configSchema: {},
      entities: ['person'],
      pipeline: { clean: true, embed: true, enrich: true },
      trustScore: 0.7,
    };
  }

  async initiateAuth(): Promise<AuthInitResult> { return { type: 'complete', auth: {} }; }
  async completeAuth(): Promise<AuthContext> { return {}; }
  async validateAuth(): Promise<boolean> { return true; }
  async revokeAuth(): Promise<void> {}
  async sync(): Promise<SyncResult> { return { cursor: null, hasMore: false, processed: 0 }; }
}

describe('ConnectorRegistry', () => {
  it('registers a connector via factory', () => {
    const registry = new ConnectorRegistry();
    registry.register(() => new TestConnector('test', 'Test'));
    expect(registry.has('test')).toBe(true);
  });

  it('gets a registered connector', () => {
    const registry = new ConnectorRegistry();
    registry.register(() => new TestConnector('test', 'Test'));
    const connector = registry.get('test');
    expect(connector.manifest.id).toBe('test');
  });

  it('throws for unknown connector', () => {
    const registry = new ConnectorRegistry();
    expect(() => registry.get('nonexistent')).toThrow('Connector "nonexistent" not found');
  });

  it('has returns false for unknown', () => {
    const registry = new ConnectorRegistry();
    expect(registry.has('nope')).toBe(false);
  });

  it('lists all manifests', () => {
    const registry = new ConnectorRegistry();
    registry.register(() => new TestConnector('a', 'A'));
    registry.register(() => new TestConnector('b', 'B'));
    const manifests = registry.list();
    expect(manifests).toHaveLength(2);
    expect(manifests.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('lists empty array when no connectors', () => {
    const registry = new ConnectorRegistry();
    expect(registry.list()).toEqual([]);
  });

  it('overwrites connector with same id', () => {
    const registry = new ConnectorRegistry();
    registry.register(() => new TestConnector('test', 'Old'));
    registry.register(() => new TestConnector('test', 'New'));
    expect(registry.get('test').manifest.name).toBe('New');
    expect(registry.list()).toHaveLength(1);
  });
});

describe('loadFromDirectory', () => {
  it('handles non-existent directory gracefully', async () => {
    const registry = new ConnectorRegistry();
    await expect(registry.loadFromDirectory('/nonexistent/path')).resolves.toBeUndefined();
    expect(registry.list()).toEqual([]);
  });
});
