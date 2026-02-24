import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PluginsService } from '../plugins.service';
import { ConnectorsService } from '../../connectors/connectors.service';
import { ConfigService } from '../../config/config.service';

describe('PluginsService', () => {
  it('registers connectors from loadAll', async () => {
    const connectors = {
      register: vi.fn(),
      list: vi.fn().mockReturnValue([{ id: 'gmail' }]),
      registry: {
        loadFromDirectory: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as ConnectorsService;

    const config = {
      pluginsDir: './plugins',
    } as unknown as ConfigService;

    const service = new PluginsService(connectors, config);

    // loadAll will try to import packages which will fail in test,
    // but should not throw - it logs warnings instead
    await service.loadAll();

    expect(connectors.registry.loadFromDirectory).toHaveBeenCalled();
  });

  it('handles import errors gracefully', async () => {
    const connectors = {
      register: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      registry: {
        loadFromDirectory: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as ConnectorsService;

    const config = {
      pluginsDir: '/nonexistent',
    } as unknown as ConfigService;

    const service = new PluginsService(connectors, config);

    // Should not throw even though imports will fail
    await expect(service.loadAll()).resolves.toBeUndefined();
  });
});
