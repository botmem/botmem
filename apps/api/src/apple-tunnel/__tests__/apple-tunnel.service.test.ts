import { describe, it, expect, vi } from 'vitest';
import { AppleTunnelService } from '../apple-tunnel.service';
import { WebSocket } from 'ws';
import { generateKeyPairSync } from 'node:crypto';

const clientPublicKeyBase64 = generateKeyPairSync('x25519')
  .publicKey.export({ format: 'der', type: 'spki' })
  .subarray(12)
  .toString('base64');

function makeMockPoolClient(
  queryHandler: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>> }>,
) {
  const query = vi.fn(async (sql: string, params?: unknown[]) =>
    queryHandler(sql, params),
  ) as ReturnType<typeof vi.fn>;
  return {
    query,
    release: vi.fn(),
  };
}

function makeMockConnectionPool(
  queryHandler: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>> }>,
) {
  const client = makeMockPoolClient(queryHandler);
  return {
    connect: vi.fn().mockResolvedValue(client),
    __client: client,
  };
}

describe('AppleTunnelService', () => {
  it('does not overwrite existing selectedSources on bridge reconnect', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const dbPool = makeMockConnectionPool(async (sql, params) => {
      queries.push({ sql, params });
      if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT auth_context FROM accounts')) {
        return {
          rows: [
            {
              auth_context:
                'enc:{"raw":{"bridgeToken":"bridge-token","selectedSources":{"contacts":true,"imessages":true}}}',
            },
          ],
        };
      }
      return { rows: [] };
    });

    const crypto = {
      decrypt: vi.fn((v: string | null) => (v ? v.replace('enc:', '') : v)),
      encrypt: vi.fn((v: string | null) => (v ? `enc:${v}` : v)),
    };

    const service = new AppleTunnelService(
      {
        queryRaw: vi.fn().mockResolvedValue([]),
        connectionPool: dbPool,
      } as never,
      crypto as never,
      { add: vi.fn() } as never,
      undefined,
    );

    vi.spyOn(service as never, 'findAccountByToken').mockResolvedValue({
      id: 'acct-1',
      userId: 'user-1',
      authContext: 'enc:{"raw":{"bridgeToken":"stale-token"}}',
      decryptedAuthContext: 'enc:{"raw":{"bridgeToken":"stale-token"}}',
    });

    const ws = { send: vi.fn() } as unknown as WebSocket;

    const result = await service.registerBridge(
      'bridge-token',
      ws,
      clientPublicKeyBase64,
      'contacts,imessages',
    );

    expect(result?.accountId).toBe('acct-1');
    expect(queries.some((q) => q.sql.startsWith('UPDATE accounts SET auth_context'))).toBe(false);
  });

  it('stores a bridge/source mismatch as an account-level warn and degrades status', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const dbPool = makeMockConnectionPool(async (sql, params) => {
      queries.push({ sql, params });
      if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT auth_context FROM accounts')) {
        return {
          rows: [
            {
              auth_context:
                'enc:{"raw":{"bridgeToken":"bridge-token","selectedSources":{"contacts":true,"imessages":true}}}',
            },
          ],
        };
      }
      return { rows: [] };
    });

    const queryRaw = vi.fn().mockResolvedValue([]);
    const crypto = {
      decrypt: vi.fn((v: string | null) => (v ? v.replace('enc:', '') : v)),
      encrypt: vi.fn((v: string | null) => (v ? `enc:${v}` : v)),
    };

    const logsService = { add: vi.fn() };
    const service = new AppleTunnelService(
      {
        queryRaw,
        connectionPool: dbPool,
      } as never,
      crypto as never,
      logsService as never,
      undefined,
    );

    vi.spyOn(service as never, 'findAccountByToken').mockResolvedValue({
      id: 'acct-1',
      userId: 'user-1',
      authContext:
        'enc:{"raw":{"bridgeToken":"stale-token","selectedSources":{"contacts":true,"imessages":true}}}',
      decryptedAuthContext:
        'enc:{"raw":{"bridgeToken":"stale-token","selectedSources":{"contacts":true,"imessages":true}}}',
    });

    const ws = { send: vi.fn() } as unknown as WebSocket;

    await service.registerBridge('bridge-token', ws, clientPublicKeyBase64, 'contacts');

    expect(queryRaw).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE accounts'),
      expect.arrayContaining([
        expect.stringContaining(
          'Apple source selection mismatch: reported [contacts=on, imessages=off]',
        ),
        'acct-1',
      ]),
    );
    expect(logsService.add).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorType: 'apple',
        accountId: 'acct-1',
        level: 'warn',
        message: expect.stringContaining(
          'Apple source selection mismatch: reported [contacts=on, imessages=off]',
        ),
      }),
    );
  });

  it('preserves bridge token under concurrent auth_context updates in account lock path', async () => {
    let updatedAuthContext: string | null = null;
    const dbPool = makeMockConnectionPool(async (sql, params) => {
      if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT auth_context FROM accounts')) {
        return {
          rows: [
            {
              auth_context:
                updatedAuthContext ?? 'enc:{"raw":{"bridgeToken":"bridge-token-fresh"}}',
            },
          ],
        };
      }
      if (sql.startsWith('UPDATE accounts SET auth_context')) {
        const encrypted = String(params?.[0] ?? '');
        updatedAuthContext = encrypted;
        return { rows: [] };
      }
      return { rows: [] };
    });

    const crypto = {
      decrypt: vi.fn((v: string | null) => (v ? v.replace('enc:', '') : v)),
      encrypt: vi.fn((v: string | null) => (v ? `enc:${v}` : v)),
    };

    const service = new AppleTunnelService(
      {
        queryRaw: vi.fn().mockResolvedValue([]),
        connectionPool: dbPool,
      } as never,
      crypto as never,
      { add: vi.fn() } as never,
      undefined,
    );

    vi.spyOn(service as never, 'findAccountByToken').mockResolvedValue({
      id: 'acct-1',
      userId: 'user-1',
      authContext: 'enc:{"raw":{"bridgeToken":"bridge-token-stale"}}',
      decryptedAuthContext: 'enc:{"raw":{"bridgeToken":"bridge-token-stale"}}',
    });

    const ws = { send: vi.fn() } as unknown as WebSocket;

    await service.registerBridge('bridge-token', ws, clientPublicKeyBase64);

    expect(updatedAuthContext).toBeTruthy();
    const payload = JSON.parse(updatedAuthContext!.replace('enc:', ''));
    expect(payload.raw.bridgeToken).toBe('bridge-token-fresh');
  });

  it('returns bridge status quickly when relay does not answer', async () => {
    vi.useFakeTimers();
    try {
      const service = new AppleTunnelService(
        {
          queryRaw: vi.fn().mockResolvedValue([]),
          connectionPool: makeMockConnectionPool(async () => ({ rows: [] })),
        } as never,
        { decrypt: vi.fn(), encrypt: vi.fn() } as never,
        { add: vi.fn() } as never,
        undefined,
      );
      (service as unknown as { redisPub: { publish: ReturnType<typeof vi.fn> } }).redisPub = {
        publish: vi.fn().mockResolvedValue(1),
      };
      (service as unknown as { redisSub: object }).redisSub = {};

      const statusPromise = service.getBridgeStatus('acct-1');
      await vi.advanceTimersByTimeAsync(3000);
      const status = await statusPromise;

      expect(status).toMatchObject({
        accountId: 'acct-1',
        connected: false,
        lastError: expect.stringContaining('Apple bridge unreachable'),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
