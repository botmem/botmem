import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalIndex, type IndexProgress } from '../local-index.js';
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
  dir = mkdtempSync(join(tmpdir(), 'bridge-li-prog-'));
});

afterEach(() => {
  index?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('LocalIndex onProgress', () => {
  it('reports a done progress event per indexed source with final counts', async () => {
    const events: IndexProgress[] = [];
    const adapters = [
      makeAdapter('contacts', [
        { sourceId: 1, senderName: 'A', ts: 0, text: 'one' },
        { sourceId: 2, senderName: 'B', ts: 0, text: 'two' },
      ]),
      makeAdapter('imessage', [{ sourceId: 1, ts: 1000, text: 'hi' }]),
      makeAdapter('whatsapp', [{ sourceId: 1, ts: 2000, text: 'skip' }], false),
    ];
    index = new LocalIndex({
      indexPath: join(dir, 'index.db'),
      adapters,
      onProgress: (p) => events.push(p),
    });
    await index.refresh();

    // absent whatsapp source emits no progress
    expect(events).toEqual([
      { source: 'contacts', count: 2, done: true },
      { source: 'imessage', count: 1, done: true },
    ]);
  });

  it('does not emit progress for a failing source', async () => {
    const events: IndexProgress[] = [];
    const boom: SourceAdapter = {
      source: 'whatsapp',
      defaultDbPath: () => '/synthetic/wa.db',
      detect: () => true,
      // eslint-disable-next-line require-yield -- throws to test isolation
      *read(): Generator<IndexRecord> {
        throw new Error('synthetic read failure');
      },
    };
    const adapters = [makeAdapter('imessage', [{ sourceId: 1, ts: 1000, text: 'ok' }]), boom];
    index = new LocalIndex({
      indexPath: join(dir, 'index.db'),
      adapters,
      onProgress: (p) => events.push(p),
    });
    await index.refresh();

    expect(events).toEqual([{ source: 'imessage', count: 1, done: true }]);
  });

  it('exposes isBuilding during a build', async () => {
    const adapter = makeAdapter('imessage', [{ sourceId: 1, ts: 1000, text: 'x' }]);
    index = new LocalIndex({ indexPath: join(dir, 'index.db'), adapters: [adapter] });
    expect(index.isBuilding).toBe(false);
    const p = index.refresh();
    expect(index.isBuilding).toBe(true);
    await p;
    expect(index.isBuilding).toBe(false);
  });
});
