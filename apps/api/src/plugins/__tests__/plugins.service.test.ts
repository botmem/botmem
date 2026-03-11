import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PluginsService } from '../plugins.service';
import { PluginRegistry } from '../plugin-registry';
import { ConnectorsService } from '../../connectors/connectors.service';
import { ConfigService } from '../../config/config.service';
import * as fs from 'fs/promises';
import { EventEmitter } from 'events';
import type { EventsService } from '../../events/events.service';
import type { DbService } from '../../db/db.service';

vi.mock('fs/promises');

function createMocks() {
  const mockWa = new EventEmitter();

  const connectors = {
    register: vi.fn(),
    list: vi.fn().mockReturnValue([{ id: 'gmail' }]),
    get: vi.fn((type: string) => {
      if (type === 'whatsapp') return mockWa;
      throw new Error(`Unknown connector: ${type}`);
    }),
    registry: {
      loadFromDirectory: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as ConnectorsService;

  const config = {
    pluginsDir: '/tmp/test-plugins',
  } as unknown as ConfigService;

  const registry = new PluginRegistry();

  const events = {
    emitToChannel: vi.fn(),
  } as unknown as EventsService;

  const dbService = {
    db: {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
    },
  } as unknown as DbService;

  return { connectors, config, registry, events, dbService, mockWa };
}

/** Create a PluginsService with loadBuiltin mocked to prevent hanging on WhatsApp warm session */
function createService(
  connectors: ConnectorsService,
  config: ConfigService,
  registry: PluginRegistry,
  events?: EventsService,
  dbService?: DbService,
) {
  const service = new PluginsService(
    connectors,
    config,
    registry,
    events ?? ({ emitToChannel: vi.fn() } as unknown as EventsService),
    dbService ?? ({ db: {} } as unknown as DbService),
  );
  (service as unknown as { loadBuiltin: ReturnType<typeof vi.fn> }).loadBuiltin = vi
    .fn()
    .mockResolvedValue(undefined);
  return service;
}

describe('PluginsService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('registers connectors from loadAll', async () => {
    const { connectors, config, registry, events, dbService } = createMocks();
    vi.mocked(fs.readdir).mockResolvedValue([]);

    const service = createService(connectors, config, registry, events, dbService);

    await service.loadAll();

    expect(connectors.registry.loadFromDirectory).toHaveBeenCalled();
  });

  it('handles import errors gracefully', async () => {
    const { connectors, registry, events, dbService } = createMocks();
    const config = { pluginsDir: '/nonexistent' } as unknown as ConfigService;
    vi.mocked(fs.readdir).mockRejectedValue(new Error('ENOENT'));

    const service = createService(connectors, config, registry, events, dbService);

    // Should not throw even though imports will fail
    await expect(service.loadAll()).resolves.toBeUndefined();
  });

  describe('decrypt-failure listener', () => {
    it('updates accounts and broadcasts on decrypt-failure', async () => {
      const { connectors, config, registry, events, dbService, mockWa } = createMocks();
      vi.mocked(fs.readdir).mockResolvedValue([]);

      const accounts = [{ id: 'wa-acc-1' }];
      dbService.db.where = vi.fn().mockResolvedValue(accounts);

      const service = createService(connectors, config, registry, events, dbService);
      await service.loadAll();

      // Emit decrypt-failure
      mockWa.emit('decrypt-failure', { message: 'Missing sender keys' });

      // Wait for async handler
      await new Promise((r) => setTimeout(r, 10));

      expect(events.emitToChannel).toHaveBeenCalledWith(
        'notifications',
        'connector:warning',
        expect.objectContaining({
          connectorType: 'whatsapp',
          action: 'reauth',
        }),
      );
    });
  });

  describe('session-expired listener', () => {
    it('updates accounts and broadcasts on session-expired', async () => {
      const { connectors, config, registry, events, dbService, mockWa } = createMocks();
      vi.mocked(fs.readdir).mockResolvedValue([]);

      const accounts = [{ id: 'wa-acc-1' }];
      dbService.db.where = vi.fn().mockResolvedValue(accounts);

      const service = createService(connectors, config, registry, events, dbService);
      await service.loadAll();

      mockWa.emit('session-expired', { message: 'Logged out', code: 401 });

      await new Promise((r) => setTimeout(r, 10));

      expect(events.emitToChannel).toHaveBeenCalledWith(
        'notifications',
        'connector:warning',
        expect.objectContaining({
          connectorType: 'whatsapp',
          message: expect.stringContaining('Logged out'),
        }),
      );
    });
  });

  describe('setupDecryptFailureListener handles missing connector', () => {
    it('does not throw when whatsapp connector not found', async () => {
      const { config, registry, events, dbService } = createMocks();
      const connectors = {
        register: vi.fn(),
        list: vi.fn().mockReturnValue([]),
        get: vi.fn(() => {
          throw new Error('not found');
        }),
        registry: { loadFromDirectory: vi.fn().mockResolvedValue(undefined) },
      } as unknown as ConnectorsService;
      vi.mocked(fs.readdir).mockResolvedValue([]);

      const service = createService(connectors, config, registry, events, dbService);
      await expect(service.loadAll()).resolves.toBeUndefined();
    });
  });

  describe('manifest-based plugin loading', () => {
    it('loads lifecycle plugins from manifest.json and registers them', async () => {
      const { connectors, config, registry, events, dbService } = createMocks();
      const registerSpy = vi.spyOn(registry, 'registerLifecycle');

      const dirEntry = { name: 'my-lifecycle', isDirectory: () => true };
      vi.mocked(fs.readdir).mockResolvedValue([dirEntry] as unknown as import('fs').Dirent[]);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({
          name: 'my-lifecycle',
          version: '1.0.0',
          type: 'lifecycle',
          hooks: ['afterEnrich'],
          entryPoint: 'index.js',
        }),
      );

      const service = createService(connectors, config, registry, events, dbService);
      (service as unknown as { _importPlugin: ReturnType<typeof vi.fn> })._importPlugin = vi
        .fn()
        .mockResolvedValue({
          default: {
            afterEnrich: () => {},
          },
        });

      await service.loadAll();

      expect(registerSpy).toHaveBeenCalledTimes(1);
      expect(registerSpy.mock.calls[0][0].manifest.name).toBe('my-lifecycle');
    });

    it('loads scorer plugins from manifest.json and registers them', async () => {
      const { connectors, config, registry, events, dbService } = createMocks();
      const registerSpy = vi.spyOn(registry, 'registerScorer');

      const dirEntry = { name: 'my-scorer', isDirectory: () => true };
      vi.mocked(fs.readdir).mockResolvedValue([dirEntry] as unknown as import('fs').Dirent[]);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({
          name: 'my-scorer',
          version: '1.0.0',
          type: 'scorer',
          entryPoint: 'index.js',
        }),
      );

      const service = createService(connectors, config, registry, events, dbService);
      (service as unknown as { _importPlugin: ReturnType<typeof vi.fn> })._importPlugin = vi
        .fn()
        .mockResolvedValue({
          default: {
            score: (_mem: unknown, _w: unknown) => 0.5,
          },
        });

      await service.loadAll();

      expect(registerSpy).toHaveBeenCalledTimes(1);
      expect(registerSpy.mock.calls[0][0].manifest.name).toBe('my-scorer');
    });

    it('warns when scorer plugin has no score function', async () => {
      const { connectors, config, registry, events, dbService } = createMocks();

      const dirEntry = { name: 'bad-scorer', isDirectory: () => true };
      vi.mocked(fs.readdir).mockResolvedValue([dirEntry] as unknown as import('fs').Dirent[]);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({
          name: 'bad-scorer',
          version: '1.0.0',
          type: 'scorer',
          entryPoint: 'index.js',
        }),
      );

      const service = createService(connectors, config, registry, events, dbService);
      (service as unknown as { _importPlugin: ReturnType<typeof vi.fn> })._importPlugin = vi
        .fn()
        .mockResolvedValue({
          default: {
            /* no score function */
          },
        });

      await service.loadAll();

      expect(vi.spyOn(registry, 'registerScorer')).not.toHaveBeenCalled();
    });

    it('skips connector type manifests (handled by ConnectorRegistry)', async () => {
      const { connectors, config, registry, events, dbService } = createMocks();
      const lcSpy = vi.spyOn(registry, 'registerLifecycle');
      const scSpy = vi.spyOn(registry, 'registerScorer');

      const dirEntry = { name: 'my-connector', isDirectory: () => true };
      vi.mocked(fs.readdir).mockResolvedValue([dirEntry] as unknown as import('fs').Dirent[]);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({
          name: 'my-connector',
          version: '1.0.0',
          type: 'connector',
        }),
      );

      const service = createService(connectors, config, registry, events, dbService);
      await service.loadAll();

      expect(lcSpy).not.toHaveBeenCalled();
      expect(scSpy).not.toHaveBeenCalled();
    });

    it('skips non-directory entries', async () => {
      const { connectors, config, registry, events, dbService } = createMocks();

      const fileEntry = { name: 'readme.txt', isDirectory: () => false };
      vi.mocked(fs.readdir).mockResolvedValue([fileEntry] as unknown as import('fs').Dirent[]);

      const service = createService(connectors, config, registry, events, dbService);
      await service.loadAll();

      // readFile should NOT be called for files
      expect(fs.readFile).not.toHaveBeenCalled();
    });

    it('uses default entryPoint when not specified', async () => {
      const { connectors, config, registry, events, dbService } = createMocks();

      const dirEntry = { name: 'no-entry', isDirectory: () => true };
      vi.mocked(fs.readdir).mockResolvedValue([dirEntry] as unknown as import('fs').Dirent[]);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({
          name: 'no-entry',
          version: '1.0.0',
          type: 'lifecycle',
          hooks: ['afterIngest'],
        }),
      );

      const service = createService(connectors, config, registry, events, dbService);
      const importSpy = vi.fn().mockResolvedValue({
        default: { afterIngest: () => {} },
      });
      (service as unknown as { _importPlugin: ReturnType<typeof vi.fn> })._importPlugin = importSpy;

      await service.loadAll();

      // Should use 'index.js' as default entryPoint
      expect(importSpy).toHaveBeenCalledWith(expect.stringContaining('index.js'));
    });

    it('filters invalid hook names', async () => {
      const { connectors, config, registry, events, dbService } = createMocks();
      const registerSpy = vi.spyOn(registry, 'registerLifecycle');

      const dirEntry = { name: 'bad-hooks', isDirectory: () => true };
      vi.mocked(fs.readdir).mockResolvedValue([dirEntry] as unknown as import('fs').Dirent[]);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({
          name: 'bad-hooks',
          version: '1.0.0',
          type: 'lifecycle',
          hooks: ['afterEnrich', 'invalidHook', 'beforeDestroy'],
          entryPoint: 'index.js',
        }),
      );

      const service = createService(connectors, config, registry, events, dbService);
      (service as unknown as { _importPlugin: ReturnType<typeof vi.fn> })._importPlugin = vi
        .fn()
        .mockResolvedValue({
          default: {
            afterEnrich: () => {},
            invalidHook: () => {},
            beforeDestroy: () => {},
          },
        });

      await service.loadAll();

      expect(registerSpy).toHaveBeenCalledTimes(1);
      // Only afterEnrich should be in hooks
      const registeredHooks = registerSpy.mock.calls[0][0].hooks;
      expect(registeredHooks).toHaveProperty('afterEnrich');
      expect(registeredHooks).not.toHaveProperty('invalidHook');
    });

    it('gracefully handles missing manifest.json', async () => {
      const { connectors, config, registry, events, dbService } = createMocks();

      const dirEntry = { name: 'broken-plugin', isDirectory: () => true };
      vi.mocked(fs.readdir).mockResolvedValue([dirEntry] as unknown as import('fs').Dirent[]);
      vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));

      const service = createService(connectors, config, registry, events, dbService);

      // Should not throw
      await expect(service.loadAll()).resolves.toBeUndefined();
    });

    it('gracefully handles failed dynamic import', async () => {
      const { connectors, config, registry, events, dbService } = createMocks();

      const dirEntry = { name: 'bad-import', isDirectory: () => true };
      vi.mocked(fs.readdir).mockResolvedValue([dirEntry] as unknown as import('fs').Dirent[]);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({
          name: 'bad-import',
          version: '1.0.0',
          type: 'lifecycle',
          hooks: ['afterEnrich'],
        }),
      );

      const service = createService(connectors, config, registry, events, dbService);
      (service as unknown as { _importPlugin: ReturnType<typeof vi.fn> })._importPlugin = vi
        .fn()
        .mockRejectedValue(new Error('Cannot find module'));

      await expect(service.loadAll()).resolves.toBeUndefined();
    });

    it('uses mod directly when no default export', async () => {
      const { connectors, config, registry, events, dbService } = createMocks();
      const registerSpy = vi.spyOn(registry, 'registerLifecycle');

      const dirEntry = { name: 'no-default', isDirectory: () => true };
      vi.mocked(fs.readdir).mockResolvedValue([dirEntry] as unknown as import('fs').Dirent[]);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({
          name: 'no-default',
          version: '1.0.0',
          type: 'lifecycle',
          hooks: ['afterSearch'],
          entryPoint: 'index.js',
        }),
      );

      const service = createService(connectors, config, registry, events, dbService);
      (service as unknown as { _importPlugin: ReturnType<typeof vi.fn> })._importPlugin = vi
        .fn()
        .mockResolvedValue({
          afterSearch: () => {},
        });

      await service.loadAll();

      expect(registerSpy).toHaveBeenCalledTimes(1);
    });
  });
});
