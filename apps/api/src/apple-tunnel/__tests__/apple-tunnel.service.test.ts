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

  it('marks the account connected (clears stale status + cancels leftover jobs) on bridge connect', async () => {
    const dbPool = makeMockConnectionPool(async () => ({ rows: [] }));
    const queryRaw = vi.fn().mockResolvedValue([]);
    const crypto = {
      decrypt: vi.fn((v: string | null) => (v ? v.replace('enc:', '') : v)),
      encrypt: vi.fn((v: string | null) => (v ? `enc:${v}` : v)),
    };
    const service = new AppleTunnelService(
      { queryRaw, connectionPool: dbPool } as never,
      crypto as never,
      { add: vi.fn() } as never,
      undefined,
    );
    vi.spyOn(service as never, 'findAccountByToken').mockResolvedValue({
      id: 'acct-1',
      userId: 'user-1',
      authContext:
        'enc:{"raw":{"bridgeToken":"t","selectedSources":{"contacts":true,"imessages":true}}}',
      decryptedAuthContext:
        'enc:{"raw":{"bridgeToken":"t","selectedSources":{"contacts":true,"imessages":true}}}',
    });
    const ws = { send: vi.fn() } as unknown as WebSocket;

    await service.registerBridge('bridge-token', ws, clientPublicKeyBase64, 'contacts,imessages');

    // Clears stale reconnect_required/degraded status + last_error.
    expect(queryRaw).toHaveBeenCalledWith(expect.stringContaining("status = 'connected'"), [
      'acct-1',
    ]);
    // Cancels any leftover queued/running sync jobs for the account.
    expect(queryRaw).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE jobs SET status = 'cancelled'[\s\S]*account_id = \$1/),
      ['acct-1'],
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

  // ── Live bridge search helpers ──────────────────────────────────────────────

  function makeService(config?: { bridgeSearchTimeoutMs?: number }) {
    return new AppleTunnelService(
      {
        queryRaw: vi.fn().mockResolvedValue([]),
        connectionPool: makeMockConnectionPool(async () => ({ rows: [] })),
      } as never,
      { decrypt: vi.fn(), encrypt: vi.fn() } as never,
      { add: vi.fn() } as never,
      config ? ({ ...config } as never) : undefined,
    );
  }

  /** Insert a fake session directly into the private maps. */
  function injectSession(
    service: AppleTunnelService,
    opts: {
      sessionId: string;
      userId: string;
      accountId: string;
      open?: boolean;
      lastSeenAt?: number;
      connectedAt?: number;
    },
  ) {
    const ws = {
      readyState: opts.open === false ? 3 /* CLOSED */ : 1 /* OPEN */,
      send: vi.fn(),
    } as unknown as WebSocket;
    const session = {
      sessionId: opts.sessionId,
      userId: opts.userId,
      accountId: opts.accountId,
      bridgeWs: opts.open === false ? null : ws,
      sessionKey: Buffer.alloc(32),
      connectedAt: opts.connectedAt ?? Date.now(),
      lastSeenAt: opts.lastSeenAt ?? Date.now(),
      pendingRpc: new Map(),
      nextRpcId: 1,
      disconnectedAt: null,
      graceTimer: null,
      heartbeatTimer: null,
      sources: { contacts: true, imessages: true },
    };
    (service as unknown as { sessions: Map<string, unknown> }).sessions.set(
      opts.sessionId,
      session,
    );
    (service as unknown as { accountSessions: Map<string, string> }).accountSessions.set(
      opts.accountId,
      opts.sessionId,
    );
    return session;
  }

  describe('getOnlineAccountIdForUser / isBridgeOnlineForUser', () => {
    it('returns the accountId for a live session of the user', () => {
      const service = makeService();
      injectSession(service, { sessionId: 's1', userId: 'u1', accountId: 'a1' });
      expect(service.getOnlineAccountIdForUser('u1')).toBe('a1');
      expect(service.isBridgeOnlineForUser('u1')).toBe(true);
    });

    it('returns null when the session ws is closed', () => {
      const service = makeService();
      injectSession(service, { sessionId: 's1', userId: 'u1', accountId: 'a1', open: false });
      expect(service.getOnlineAccountIdForUser('u1')).toBeNull();
      expect(service.isBridgeOnlineForUser('u1')).toBe(false);
    });

    it('returns null when the session is stale (past heartbeat window)', () => {
      const service = makeService();
      injectSession(service, {
        sessionId: 's1',
        userId: 'u1',
        accountId: 'a1',
        lastSeenAt: Date.now() - 200_000,
      });
      expect(service.getOnlineAccountIdForUser('u1')).toBeNull();
    });

    it('returns null for an unknown user', () => {
      const service = makeService();
      injectSession(service, { sessionId: 's1', userId: 'u1', accountId: 'a1' });
      expect(service.getOnlineAccountIdForUser('other')).toBeNull();
    });

    it('picks the most recently connected session when user has multiple', () => {
      const service = makeService();
      injectSession(service, {
        sessionId: 's1',
        userId: 'u1',
        accountId: 'a1',
        connectedAt: 1000,
      });
      injectSession(service, {
        sessionId: 's2',
        userId: 'u1',
        accountId: 'a2',
        connectedAt: 2000,
      });
      expect(service.getOnlineAccountIdForUser('u1')).toBe('a2');
    });
  });

  describe('searchViaBridge', () => {
    it('returns null when no online account', async () => {
      const service = makeService();
      const result = await service.searchViaBridge('u1', { query: 'hi' });
      expect(result).toBeNull();
    });

    it('calls search.query and returns items on success', async () => {
      const service = makeService();
      injectSession(service, { sessionId: 's1', userId: 'u1', accountId: 'a1' });
      const spy = vi
        .spyOn(service as never, 'sendLocalRpcRequest')
        .mockResolvedValue({ items: [{ id: 'm1' }] } as never);

      const result = await service.searchViaBridge('u1', {
        query: 'hi',
        filters: { connectorType: 'apple' },
        limit: 5,
      });

      expect(spy).toHaveBeenCalledWith('a1', 'search.query', {
        query: 'hi',
        filters: { connectorType: 'apple' },
        limit: 5,
      });
      expect(result).toEqual({ items: [{ id: 'm1' }] });
    });

    it('returns { items: [] } when result has no items array', async () => {
      const service = makeService();
      injectSession(service, { sessionId: 's1', userId: 'u1', accountId: 'a1' });
      vi.spyOn(service as never, 'sendLocalRpcRequest').mockResolvedValue({} as never);
      const result = await service.searchViaBridge('u1', { query: 'hi' });
      expect(result).toEqual({ items: [] });
    });

    it('returns null on RPC error', async () => {
      const service = makeService();
      injectSession(service, { sessionId: 's1', userId: 'u1', accountId: 'a1' });
      vi.spyOn(service as never, 'sendLocalRpcRequest').mockRejectedValue(
        new Error('boom') as never,
      );
      const result = await service.searchViaBridge('u1', { query: 'hi' });
      expect(result).toBeNull();
    });

    it('returns null on timeout', async () => {
      vi.useFakeTimers();
      try {
        const service = makeService({ bridgeSearchTimeoutMs: 1000 });
        injectSession(service, { sessionId: 's1', userId: 'u1', accountId: 'a1' });
        vi.spyOn(service as never, 'sendLocalRpcRequest').mockImplementation(
          () => new Promise(() => {}) as never,
        );
        const promise = service.searchViaBridge('u1', { query: 'hi' });
        await vi.advanceTimersByTimeAsync(1000);
        await expect(promise).resolves.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('bridgeStatusForUser', () => {
    it('returns null when offline', async () => {
      const service = makeService();
      expect(await service.bridgeStatusForUser('u1')).toBeNull();
    });

    it('normalizes sources from bridge.status RPC', async () => {
      const service = makeService();
      injectSession(service, { sessionId: 's1', userId: 'u1', accountId: 'a1' });
      vi.spyOn(service as never, 'sendLocalRpcRequest').mockResolvedValue({
        sources: [
          { source: 'imessage', count: 10, lastIndexedAt: '2026-01-01T00:00:00.000Z' },
          { source: 'contacts', count: '5', lastIndexedAt: null },
          'junk',
        ],
      } as never);

      const result = await service.bridgeStatusForUser('u1');
      expect(result).toEqual({
        sources: [
          { source: 'imessage', count: 10, lastIndexedAt: '2026-01-01T00:00:00.000Z' },
          { source: 'contacts', count: 5, lastIndexedAt: null },
          { source: '', count: 0, lastIndexedAt: null },
        ],
      });
    });

    it('returns null on RPC error', async () => {
      const service = makeService();
      injectSession(service, { sessionId: 's1', userId: 'u1', accountId: 'a1' });
      vi.spyOn(service as never, 'sendLocalRpcRequest').mockRejectedValue(
        new Error('nope') as never,
      );
      expect(await service.bridgeStatusForUser('u1')).toBeNull();
    });
  });
});
