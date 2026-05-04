import { describe, expect, it } from 'vitest';
import { RawEventPipelineClassifier } from '../raw-event-pipeline-classifier.service';
import type { rawEvents } from '../../db/schema';
import type { ConnectorDataEvent } from '@botmem/connector-sdk';

type LoadedRawEvent = typeof rawEvents.$inferSelect;

function raw(partial: Partial<LoadedRawEvent>): LoadedRawEvent {
  return {
    id: 'raw-1',
    accountId: 'acc-1',
    connectorType: 'gmail',
    sourceId: 'src-1',
    sourceHash: 'hash-1',
    sourceType: 'message',
    payload: '{}',
    cleanedText: null,
    processingState: 'pending',
    timestamp: new Date('2026-05-04T08:00:00.000Z'),
    jobId: 'job-1',
    createdAt: new Date('2026-05-04T08:00:00.000Z'),
    ...partial,
  };
}

function event(partial: Partial<ConnectorDataEvent>): ConnectorDataEvent {
  return {
    sourceType: 'message',
    sourceId: 'src-1',
    timestamp: '2026-05-04T08:00:00.000Z',
    content: { text: 'hello', metadata: {} },
    ...partial,
  };
}

describe('RawEventPipelineClassifier', () => {
  const classifier = new RawEventPipelineClassifier();

  it('routes WhatsApp identity events before memory creation', () => {
    expect(
      classifier.classify(
        raw({ connectorType: 'whatsapp', sourceId: 'wa-group:123@g.us' }),
        event({ sourceId: 'wa-group:123@g.us' }),
      ),
    ).toBe('whatsapp_group_identity');

    expect(
      classifier.classify(
        raw({ connectorType: 'whatsapp', sourceId: 'wa-contact:123@lid' }),
        event({ sourceId: 'wa-contact:123@lid' }),
      ),
    ).toBe('whatsapp_contact_identity');
  });

  it('keeps Gmail contacts as identity events and skips other metadata contacts', () => {
    expect(
      classifier.classify(
        raw({ connectorType: 'gmail', sourceType: 'contact' }),
        event({ sourceType: 'contact', content: { text: 'Alice', metadata: { type: 'contact' } } }),
      ),
    ).toBe('gmail_contact_identity');

    expect(
      classifier.classify(
        raw({ connectorType: 'slack', sourceType: 'contact' }),
        event({ sourceType: 'contact', content: { text: 'Alice', metadata: { type: 'contact' } } }),
      ),
    ).toBe('skip_contact');
  });

  it('routes normal messages to memory processing', () => {
    expect(classifier.classify(raw({ connectorType: 'slack' }), event({}))).toBe('memory');
  });
});
