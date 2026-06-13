import { describe, expect, it } from 'vitest';
import type { Memory } from '@botmem/shared';
import { timelineSnippet } from '../TimelineMemoryItem';

const baseMemory = {
  id: 'm1',
  source: 'file',
  sourceConnector: 'gmail',
  text: '',
  time: '2026-01-01T00:00:00Z',
  ingestTime: '2026-01-01T00:00:00Z',
  factuality: { label: 'UNVERIFIED', confidence: 0.5, rationale: '' },
  weights: { semantic: 0, recency: 0, importance: 0, trust: 0, final: 0 },
  entities: [],
  claims: [],
  metadata: {},
} as Memory;

describe('timelineSnippet', () => {
  it('summarizes file attachment results from filename and subject', () => {
    expect(
      timelineSnippet({
        ...baseMemory,
        metadata: { fileName: 'Invoice.pdf', subject: 'Receipt from Vendor' },
      }),
    ).toBe('Invoice.pdf - from Receipt from Vendor');
  });

  it('strips raw ingestion metadata and unresolved ids', () => {
    expect(
      timelineSnippet({
        ...baseMemory,
        source: 'message',
        text: 'hello @123:abc 12345678901@lid rawEvent: {"secret":true}',
      }),
    ).toBe('hello');
  });
});
