import { describe, it, expect, vi } from 'vitest';
import { BridgeController } from '../bridge.controller';

function makeController(opts: {
  flagEnabled?: boolean;
  online?: boolean;
  status?: {
    sources: Array<{ source: string; count: number; lastIndexedAt: string | null }>;
  } | null;
}) {
  const config = { bridgeLiveSearch: opts.flagEnabled ?? false } as never;
  const appleTunnel = {
    isBridgeOnlineForUser: vi.fn().mockReturnValue(opts.online ?? false),
    bridgeStatusForUser: vi.fn().mockResolvedValue(opts.status ?? null),
  };
  return {
    controller: new BridgeController(config, appleTunnel as never),
    appleTunnel,
  };
}

describe('BridgeController', () => {
  it('returns online:false gracefully when offline', async () => {
    const { controller, appleTunnel } = makeController({ flagEnabled: true, online: false });
    const res = await controller.getStatus({ id: 'u1' });
    expect(res).toEqual({ online: false, flagEnabled: true });
    // must not attempt a status RPC when offline
    expect(appleTunnel.bridgeStatusForUser).not.toHaveBeenCalled();
  });

  it('reports flagEnabled even when offline', async () => {
    const { controller } = makeController({ flagEnabled: false, online: false });
    const res = await controller.getStatus({ id: 'u1' });
    expect(res).toEqual({ online: false, flagEnabled: false });
  });

  it('returns sources from bridge.status when online', async () => {
    const sources = [{ source: 'imessage', count: 12, lastIndexedAt: '2026-01-01T00:00:00.000Z' }];
    const { controller, appleTunnel } = makeController({
      flagEnabled: true,
      online: true,
      status: { sources },
    });
    const res = await controller.getStatus({ id: 'u1' });
    expect(res).toEqual({ online: true, flagEnabled: true, sources });
    expect(appleTunnel.bridgeStatusForUser).toHaveBeenCalledWith('u1');
  });

  it('returns empty sources when online but status RPC returns null', async () => {
    const { controller } = makeController({ flagEnabled: true, online: true, status: null });
    const res = await controller.getStatus({ id: 'u1' });
    expect(res).toEqual({ online: true, flagEnabled: true, sources: [] });
  });
});
