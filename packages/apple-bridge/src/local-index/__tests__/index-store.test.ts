import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IndexStore, connectorTypeToSource, sourceToConnectorType } from '../index-store.js';
import type { IndexRecord } from '../types.js';

let dir: string;
let store: IndexStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-idx-'));
  store = new IndexStore(join(dir, 'index.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const TS_2024 = Math.floor(new Date('2024-06-01T12:00:00Z').getTime() / 1000);

function seed(): void {
  const imsg: IndexRecord[] = [
    {
      sourceId: 1,
      threadId: 'chat-a',
      threadTitle: 'Family',
      senderName: 'Alice',
      senderId: '+1000',
      isFromMe: false,
      ts: TS_2024,
      text: 'lets meet for dinner tonight',
      media: [],
    },
    {
      sourceId: 2,
      threadId: 'chat-a',
      threadTitle: 'Family',
      senderName: 'Me',
      senderId: '+1999',
      isFromMe: true,
      ts: TS_2024 + 60,
      text: 'sounds good see you at the restaurant',
      media: [{ filename: 'photo.jpg' }],
    },
  ];
  const wa: IndexRecord[] = [
    {
      sourceId: 10,
      threadId: 'group@g.us',
      threadTitle: 'Work',
      senderName: 'Bob',
      senderId: '111@lid',
      isFromMe: false,
      ts: TS_2024 + 120,
      text: 'dinner deck is ready for review',
      media: [],
    },
  ];
  const contacts: IndexRecord[] = [
    {
      sourceId: 'default:5',
      threadTitle: 'Contacts',
      senderName: 'Charlie Brown',
      ts: 0,
      text: 'Charlie Brown — Acme Inc',
      media: [],
    },
  ];
  store.addRecords('imessage', imsg);
  store.addRecords('whatsapp', wa);
  store.addRecords('contacts', contacts);
  store.setSourceState('imessage', imsg.length, 'c1');
  store.setSourceState('whatsapp', wa.length, 'c2');
  store.setSourceState('contacts', contacts.length, 'c3');
}

describe('connector <-> source mapping', () => {
  it('maps internal source to wire connectorType', () => {
    expect(sourceToConnectorType('imessage')).toBe('apple');
    expect(sourceToConnectorType('whatsapp')).toBe('whatsapp');
    expect(sourceToConnectorType('contacts')).toBe('contacts');
  });

  it('maps wire connectorType back to source name (apple->imessage)', () => {
    expect(connectorTypeToSource('apple')).toBe('imessage');
    expect(connectorTypeToSource('imessage')).toBe('imessage');
    expect(connectorTypeToSource('whatsapp')).toBe('whatsapp');
    expect(connectorTypeToSource('contacts')).toBe('contacts');
    expect(connectorTypeToSource('unknown')).toBeUndefined();
  });
});

describe('IndexStore add/search/status/reset', () => {
  beforeEach(seed);

  it('reports per-source status counts and timestamps', () => {
    const status = store.status();
    const bySource = Object.fromEntries(status.map((s) => [s.source, s]));
    expect(bySource.imessage.count).toBe(2);
    expect(bySource.whatsapp.count).toBe(1);
    expect(bySource.contacts.count).toBe(1);
    expect(typeof bySource.imessage.lastIndexedAt).toBe('number');
  });

  it('searches across sources and orders best match first', () => {
    const items = store.search('dinner');
    // imessage + whatsapp both mention dinner; contacts do not
    expect(items.length).toBe(2);
    const ids = items.map((i) => i.id).sort();
    expect(ids).toEqual(['imessage:1', 'whatsapp:10']);
    // scores are descending (higher = better)
    expect(items[0].score).toBeGreaterThanOrEqual(items[1].score);
  });

  it('produces the documented SearchItem shape', () => {
    const [item] = store.search('restaurant');
    expect(item).toMatchObject({
      id: 'imessage:2',
      connectorType: 'apple',
      sourceType: 'message',
      threadTitle: 'Family',
      isFromMe: true,
    });
    expect(item.eventTime).toBe(new Date((TS_2024 + 60) * 1000).toISOString());
    expect(item.people).toEqual([{ name: 'Me', durableId: '+1999' }]);
    expect(item.media).toEqual([{ filename: 'photo.jpg' }]);
    expect(typeof item.score).toBe('number');
  });

  it('returns null eventTime and empty people for contact records', () => {
    const [item] = store.search('Charlie');
    expect(item.connectorType).toBe('contacts');
    expect(item.sourceType).toBe('contact');
    expect(item.eventTime).toBeNull();
    expect(item.people).toEqual([{ name: 'Charlie Brown', durableId: '' }]);
  });

  it('filters by internal source name', () => {
    const items = store.search('dinner', { source: 'whatsapp' });
    expect(items.map((i) => i.id)).toEqual(['whatsapp:10']);
  });

  it('filters by connectorType (apple maps to imessage)', () => {
    const items = store.search('dinner', { connectorType: 'apple' });
    expect(items.map((i) => i.id)).toEqual(['imessage:1']);
  });

  it('filters by sourceType=contact', () => {
    const items = store.search('Charlie', { sourceType: 'contact' });
    expect(items).toHaveLength(1);
    expect(items[0].connectorType).toBe('contacts');
  });

  it('filters by sourceType=message (excludes contacts)', () => {
    const items = store.search('Charlie', { sourceType: 'message' });
    expect(items).toHaveLength(0);
  });

  it('honors the limit', () => {
    const items = store.search('dinner', {}, 1);
    expect(items).toHaveLength(1);
  });

  it('returns [] for empty/whitespace queries', () => {
    expect(store.search('   ')).toEqual([]);
    expect(store.search('')).toEqual([]);
  });

  it('tolerates FTS special characters via phrase quoting', () => {
    expect(() => store.search('dinner "tonight')).not.toThrow();
  });

  it('reset clears records and source state', () => {
    store.reset();
    expect(store.status()).toEqual([]);
    expect(store.search('dinner')).toEqual([]);
  });
});
