import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalIndex } from '../local-index.js';
import type { IndexRecord, SourceAdapter } from '../types.js';

let dir: string;
let index: LocalIndex;

function makeAdapter(
  source: SourceAdapter['source'],
  records: IndexRecord[],
  present = true,
): SourceAdapter {
  return {
    source,
    defaultDbPath: () => `/synthetic/${source}.db`,
    detect: () => present,
    *read() {
      yield* records;
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-li-'));
});

afterEach(() => {
  index?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('LocalIndex build/refresh', () => {
  it('builds from present sources and skips absent ones (WhatsApp absence)', async () => {
    const adapters = [
      makeAdapter('contacts', [{ sourceId: 1, senderName: 'Dana', ts: 0, text: 'Dana Scully' }]),
      makeAdapter('imessage', [{ sourceId: 1, ts: 1000, text: 'hello world', threadTitle: 'T' }]),
      // WhatsApp not installed → detect() false → skipped
      makeAdapter('whatsapp', [{ sourceId: 1, ts: 2000, text: 'never indexed' }], false),
    ];
    index = new LocalIndex({ indexPath: join(dir, 'index.db'), adapters });
    await index.refresh();

    const status = Object.fromEntries(index.status().map((s) => [s.source, s.count]));
    expect(status.contacts).toBe(1);
    expect(status.imessage).toBe(1);
    expect(status.whatsapp).toBeUndefined(); // skipped, no state row
    expect(index.search('never').length).toBe(0);
    expect(index.search('hello').map((i) => i.id)).toEqual(['imessage:1']);
  });

  it('isolates a failing source without aborting others', async () => {
    const boom: SourceAdapter = {
      source: 'whatsapp',
      defaultDbPath: () => '/synthetic/wa.db',
      detect: () => true,
      // eslint-disable-next-line require-yield -- intentionally throws before yielding to test failure isolation
      *read(): Generator<IndexRecord> {
        throw new Error('synthetic read failure');
      },
    };
    const adapters = [
      makeAdapter('imessage', [{ sourceId: 1, ts: 1000, text: 'survives the failure' }]),
      boom,
    ];
    index = new LocalIndex({ indexPath: join(dir, 'index.db'), adapters });
    await index.refresh();

    const status = Object.fromEntries(index.status().map((s) => [s.source, s.count]));
    expect(status.imessage).toBe(1);
    expect(status.whatsapp).toBeUndefined();
    expect(index.search('survives').map((i) => i.id)).toEqual(['imessage:1']);
  });

  it('coalesces concurrent refreshes', async () => {
    let reads = 0;
    const adapter: SourceAdapter = {
      source: 'imessage',
      defaultDbPath: () => '/synthetic/i.db',
      detect: () => true,
      *read(): Generator<IndexRecord> {
        reads++;
        yield { sourceId: 1, ts: 1000, text: 'concurrent' };
      },
    };
    index = new LocalIndex({ indexPath: join(dir, 'index.db'), adapters: [adapter] });
    await Promise.all([index.refresh(), index.refresh()]);
    expect(reads).toBe(1);
  });

  it('rebuilds from scratch on each refresh (no duplicates)', async () => {
    const adapter = makeAdapter('imessage', [{ sourceId: 1, ts: 1000, text: 'rebuild me' }]);
    index = new LocalIndex({ indexPath: join(dir, 'index.db'), adapters: [adapter] });
    await index.refresh();
    await index.refresh();
    expect(index.search('rebuild')).toHaveLength(1);
    expect(index.status().find((s) => s.source === 'imessage')?.count).toBe(1);
  });
});
