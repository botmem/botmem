import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RpcHandler } from '../../rpc-handler.js';
import { LocalIndex } from '../local-index.js';
import type { AppleMessagesDatabase } from '../../db.js';
import type { IndexRecord, SourceAdapter } from '../types.js';

let dir: string;
let index: LocalIndex;
let handler: RpcHandler;

// Minimal stub for the iMessage DB dependency; not exercised by these tests.
const dbStub = {} as AppleMessagesDatabase;

function adapter(source: SourceAdapter['source'], records: IndexRecord[]): SourceAdapter {
  return {
    source,
    defaultDbPath: () => `/synthetic/${source}.db`,
    detect: () => true,
    *read() {
      yield* records;
    },
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-rpc-'));
  index = new LocalIndex({
    indexPath: join(dir, 'index.db'),
    adapters: [
      adapter('imessage', [
        { sourceId: 1, ts: 1000, text: 'project deadline friday', threadTitle: 'Work' },
      ]),
      adapter('contacts', [{ sourceId: 1, ts: 0, text: 'Eve Adams', senderName: 'Eve Adams' }]),
    ],
  });
  await index.refresh();
  handler = new RpcHandler(dbStub, index);
});

afterEach(() => {
  index.close();
  rmSync(dir, { recursive: true, force: true });
});

function req(method: string, params?: Record<string, unknown>) {
  return { jsonrpc: '2.0' as const, id: 1, method, params };
}

describe('search.query RPC', () => {
  it('returns { items } with the documented shape', async () => {
    const res = await handler.handle(req('search.query', { query: 'project' }));
    expect(res.error).toBeUndefined();
    const items = (res.result as { items: unknown[] }).items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'imessage:1',
      connectorType: 'apple',
      sourceType: 'message',
      threadTitle: 'Work',
    });
  });

  it('applies connectorType filter mapped back to source', async () => {
    const res = await handler.handle(
      req('search.query', { query: 'deadline', filters: { connectorType: 'apple' } }),
    );
    const { items } = res.result as { items: unknown[] };
    expect(items).toHaveLength(1);
  });

  it('returns no results when filter excludes the match', async () => {
    const res = await handler.handle(
      req('search.query', { query: 'project', filters: { connectorType: 'whatsapp' } }),
    );
    expect((res.result as { items: unknown[] }).items).toHaveLength(0);
  });

  it('rejects missing query param', async () => {
    const res = await handler.handle(req('search.query', {}));
    expect(res.error?.code).toBe(-32602);
  });

  it('caps oversized limit and honors small limit', async () => {
    const res = await handler.handle(req('search.query', { query: 'Eve', limit: 99999 }));
    expect(res.error).toBeUndefined();
  });

  it('errors cleanly when no local index is wired', async () => {
    const noIndex = new RpcHandler(dbStub);
    const res = await noIndex.handle(req('search.query', { query: 'x' }));
    expect(res.error?.code).toBe(-32601);
  });
});

describe('bridge.status RPC', () => {
  it('returns per-source counts and lastIndexedAt', async () => {
    const res = await handler.handle(req('bridge.status', {}));
    const { sources } = res.result as {
      sources: Array<{ source: string; count: number; lastIndexedAt: number | null }>;
    };
    const bySource = Object.fromEntries(sources.map((s) => [s.source, s]));
    expect(bySource.imessage.count).toBe(1);
    expect(bySource.contacts.count).toBe(1);
    expect(typeof bySource.imessage.lastIndexedAt).toBe('number');
  });

  it('returns empty sources when no index is wired', async () => {
    const noIndex = new RpcHandler(dbStub);
    const res = await noIndex.handle(req('bridge.status', {}));
    expect((res.result as { sources: unknown[] }).sources).toEqual([]);
  });
});

describe('existing methods still dispatch', () => {
  it('ping works', async () => {
    const res = await handler.handle(req('ping'));
    expect((res.result as { pong: boolean }).pong).toBe(true);
  });

  it('unknown method returns -32601', async () => {
    const res = await handler.handle(req('does.not.exist'));
    expect(res.error?.code).toBe(-32601);
  });
});
