import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PluginsService } from '../plugins.service';
import { PluginRegistry } from '../plugin-registry';
import { ConnectorsService } from '../../connectors/connectors.service';
import { ConfigService } from '../../config/config.service';
import * as fs from 'fs/promises';
import * as path from 'path';

vi.mock('fs/promises');

function createMocks() {
  const connectors = {
    register: vi.fn(),
    list: vi.fn().mockReturnValue([{ id: 'gmail' }]),
    registry: {
      loadFromDirectory: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as ConnectorsService;

  const config = {
    pluginsDir: '/tmp/test-plugins',
  } as unknown as ConfigService;

  const registry = new PluginRegistry();

  return { connectors, config, registry };
}

describe('PluginsService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('registers connectors from loadAll', async () => {
    const { connectors, config, registry } = createMocks();
    vi.mocked(fs.readdir).mockResolvedValue([]);

    const service = new PluginsService(connectors, config, registry);

    // loadAll will try to import packages which will fail in test,
    // but should not throw - it logs warnings instead
    await service.loadAll();

    expect(connectors.registry.loadFromDirectory).toHaveBeenCalled();
  });

  it('handles import errors gracefully', async () => {
    const { connectors, registry } = createMocks();
    const config = { pluginsDir: '/nonexistent' } as unknown as ConfigService;
    vi.mocked(fs.readdir).mockRejectedValue(new Error('ENOENT'));

    const service = new PluginsService(connectors, config, registry);

    // Should not throw even though imports will fail
    await expect(service.loadAll()).resolves.toBeUndefined();
  });

  describe('manifest-based plugin loading', () => {
    it('loads lifecycle plugins from manifest.json and registers them', async () => {
      const { connectors, config, registry } = createMocks();
      const registerSpy = vi.spyOn(registry, 'registerLifecycle');

      const dirEntry = { name: 'my-lifecycle', isDirectory: () => true };
      vi.mocked(fs.readdir).mockResolvedValue([dirEntry] as any);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({
          name: 'my-lifecycle',
          version: '1.0.0',
          type: 'lifecycle',
          hooks: ['afterEnrich'],
          entryPoint: 'index.js',
        }),
      );

      const service = new PluginsService(connectors, config, registry);
      // Mock the dynamic import
      (service as any)._importPlugin = vi.fn().mockResolvedValue({
        default: {
          afterEnrich: () => {},
        },
      });

      await service.loadAll();

      expect(registerSpy).toHaveBeenCalledTimes(1);
      expect(registerSpy.mock.calls[0][0].manifest.name).toBe('my-lifecycle');
    });

    it('loads scorer plugins from manifest.json and registers them', async () => {
      const { connectors, config, registry } = createMocks();
      const registerSpy = vi.spyOn(registry, 'registerScorer');

      const dirEntry = { name: 'my-scorer', isDirectory: () => true };
      vi.mocked(fs.readdir).mockResolvedValue([dirEntry] as any);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({
          name: 'my-scorer',
          version: '1.0.0',
          type: 'scorer',
          entryPoint: 'index.js',
        }),
      );

      const service = new PluginsService(connectors, config, registry);
      (service as any)._importPlugin = vi.fn().mockResolvedValue({
        default: {
          score: (_mem: any, _w: any) => 0.5,
        },
      });

      await service.loadAll();

      expect(registerSpy).toHaveBeenCalledTimes(1);
      expect(registerSpy.mock.calls[0][0].manifest.name).toBe('my-scorer');
    });

    it('skips connector type manifests (handled by ConnectorRegistry)', async () => {
      const { connectors, config, registry } = createMocks();
      const lcSpy = vi.spyOn(registry, 'registerLifecycle');
      const scSpy = vi.spyOn(registry, 'registerScorer');

      const dirEntry = { name: 'my-connector', isDirectory: () => true };
      vi.mocked(fs.readdir).mockResolvedValue([dirEntry] as any);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({
          name: 'my-connector',
          version: '1.0.0',
          type: 'connector',
        }),
      );

      const service = new PluginsService(connectors, config, registry);
      await service.loadAll();

      expect(lcSpy).not.toHaveBeenCalled();
      expect(scSpy).not.toHaveBeenCalled();
    });

    it('gracefully handles missing manifest.json', async () => {
      const { connectors, config, registry } = createMocks();

      const dirEntry = { name: 'broken-plugin', isDirectory: () => true };
      vi.mocked(fs.readdir).mockResolvedValue([dirEntry] as any);
      vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));

      const service = new PluginsService(connectors, config, registry);

      // Should not throw
      await expect(service.loadAll()).resolves.toBeUndefined();
    });

    it('gracefully handles failed dynamic import', async () => {
      const { connectors, config, registry } = createMocks();

      const dirEntry = { name: 'bad-import', isDirectory: () => true };
      vi.mocked(fs.readdir).mockResolvedValue([dirEntry] as any);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({
          name: 'bad-import',
          version: '1.0.0',
          type: 'lifecycle',
          hooks: ['afterEnrich'],
        }),
      );

      const service = new PluginsService(connectors, config, registry);
      (service as any)._importPlugin = vi
        .fn()
        .mockRejectedValue(new Error('Cannot find module'));

      await expect(service.loadAll()).resolves.toBeUndefined();
    });
  });
});
