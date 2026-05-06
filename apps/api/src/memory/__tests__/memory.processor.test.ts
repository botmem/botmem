import { describe, expect, it } from 'vitest';
import {
  buildWhatsAppGroupIdentity,
  shouldMergeEntityResolutionBucket,
} from '../connector-normalizers/whatsapp-group-identity';
import { buildWhatsAppContactIdentity } from '../connector-normalizers/whatsapp-contact-identity';
import { MemoryProcessor } from '../memory.processor';

describe('shouldMergeEntityResolutionBucket', () => {
  it('never fuses person entities before person resolution', () => {
    expect(
      shouldMergeEntityResolutionBucket(
        'person',
        'participant',
        {
          entityType: 'person',
          role: 'participant',
          identifiers: [
            { type: 'name', value: 'Amr', connectorType: 'whatsapp' },
            { type: 'phone', value: '+971502284498', connectorType: 'whatsapp' },
          ],
        },
        [
          { type: 'name', value: 'Amr', connectorType: 'whatsapp' },
          { type: 'phone', value: '+971504024690', connectorType: 'whatsapp' },
        ],
      ),
    ).toBe(false);
  });

  it('uses typed identifier equality for non-person entity buckets', () => {
    expect(
      shouldMergeEntityResolutionBucket(
        'group',
        'group',
        {
          entityType: 'group',
          role: 'group',
          identifiers: [{ type: 'whatsapp_group_jid', value: '120363', connectorType: 'whatsapp' }],
        },
        [{ type: 'whatsapp_group_jid', value: '120363', connectorType: 'whatsapp' }],
      ),
    ).toBe(true);

    expect(
      shouldMergeEntityResolutionBucket(
        'group',
        'group',
        {
          entityType: 'group',
          role: 'group',
          identifiers: [{ type: 'name', value: '120363', connectorType: 'whatsapp' }],
        },
        [{ type: 'whatsapp_group_jid', value: '120363', connectorType: 'whatsapp' }],
      ),
    ).toBe(false);
  });
});

describe('buildWhatsAppGroupIdentity', () => {
  it('preserves WhatsApp group members as people and the group as a group', () => {
    const result = buildWhatsAppGroupIdentity({
      sourceType: 'contact',
      sourceId: 'wa-group:120363000000000000@g.us',
      timestamp: new Date().toISOString(),
      content: {
        text: 'WhatsApp group: Friends',
        metadata: {
          name: 'Friends',
          groupJid: '120363000000000000@g.us',
          memberPhones: ['971500000001'],
          memberLids: ['123456789'],
          memberJids: ['971500000002@s.whatsapp.net', '987654321@lid'],
        },
      },
    });

    expect(result?.groupIdentifiers).toContainEqual({
      type: 'whatsapp_group_jid',
      value: '120363000000000000@g.us',
      connectorType: 'whatsapp',
    });
    expect(result?.groupIdentifiers).toContainEqual({
      type: 'name',
      value: 'Friends',
      connectorType: 'whatsapp',
    });
    expect(result?.members.map((m) => m.identifiers[0])).toEqual(
      expect.arrayContaining([
        { type: 'phone', value: '+971500000001', connectorType: 'whatsapp' },
        { type: 'phone', value: '+971500000002', connectorType: 'whatsapp' },
        { type: 'whatsapp_lid', value: '123456789', connectorType: 'whatsapp' },
        { type: 'whatsapp_lid', value: '987654321', connectorType: 'whatsapp' },
      ]),
    );
  });
});

describe('buildWhatsAppContactIdentity', () => {
  it('turns WhatsApp contact metadata into durable person identifiers', () => {
    const result = buildWhatsAppContactIdentity(
      {
        sourceType: 'contact',
        sourceId: 'wa-contact:971508556252',
        timestamp: new Date().toISOString(),
        content: {
          text: 'WhatsApp contact: Moataz Aly (+971508556252)',
          participants: ['971508556252'],
          metadata: {
            type: 'contact',
            name: 'Moataz Aly',
            phone: '971508556252',
            whatsappLid: '49293440377068@lid',
          },
        },
      },
      'whatsapp',
    );

    expect(result?.identifiers).toEqual([
      { type: 'phone', value: '+971508556252', connectorType: 'whatsapp' },
      { type: 'whatsapp_lid', value: '49293440377068', connectorType: 'whatsapp' },
      { type: 'name', value: 'Moataz Aly', connectorType: 'whatsapp' },
    ]);
  });

  it('refuses name-only WhatsApp contacts', () => {
    const result = buildWhatsAppContactIdentity(
      {
        sourceType: 'contact',
        sourceId: 'wa-contact:unknown',
        timestamp: new Date().toISOString(),
        content: {
          text: 'WhatsApp contact: Unknown',
          metadata: { type: 'contact', name: 'Unknown' },
        },
      },
      'whatsapp',
    );

    expect(result).toBeNull();
  });
});

describe('media extraction metadata', () => {
  it('represents message media as a file memory with connector provenance and extraction evidence', () => {
    const proto = MemoryProcessor.prototype as unknown as {
      memorySourceTypeForEvent(sourceType: string, media: unknown): string;
      buildMediaMemoryText(input: {
        connectorType: string;
        originalSourceType: string;
        media: {
          kind: string;
          mimeType: string;
          fileName?: string;
          hasInlineContent: boolean;
          hasFetchableUrl: boolean;
        };
        metadata: Record<string, unknown>;
        originalText: string;
        currentText: string;
      }): string;
    };
    const media = {
      kind: 'image',
      mimeType: 'image/jpeg',
      fileName: 'receipt.jpg',
      hasInlineContent: true,
      hasFetchableUrl: false,
    };

    expect(proto.memorySourceTypeForEvent('message', media)).toBe('file');

    const text = proto.buildMediaMemoryText({
      connectorType: 'whatsapp',
      originalSourceType: 'message',
      media,
      metadata: {
        mediaExtraction: {
          extractedText: 'Visible total: AED 120',
          confidenceLabel: 'medium',
          warnings: ['ocr_date_disagrees_with_event_time'],
        },
      },
      originalText: 'Mom sent an image',
      currentText: 'Visible total: AED 120\n\nMom sent an image',
    });

    expect(text).toContain('File from WhatsApp');
    expect(text).toContain('Connector: whatsapp');
    expect(text).toContain('Original source type: message');
    expect(text).toContain('Extracted media text (medium confidence):');
    expect(text).toContain('Visible total: AED 120');
    expect(text).toContain('Extraction warnings: ocr_date_disagrees_with_event_time');
  });

  it('records low-confidence warnings when OCR dates disagree with event time', () => {
    const metadata = (
      MemoryProcessor.prototype as unknown as {
        buildMediaExtractionMetadata(input: {
          status: string;
          source: string;
          extractedText?: string;
          eventTimestamp?: string;
        }): Record<string, unknown>;
      }
    ).buildMediaExtractionMetadata({
      status: 'extracted',
      source: 'vision_ocr',
      extractedText: 'Official document dated 2021',
      eventTimestamp: '2026-05-01T00:00:00.000Z',
    });

    expect(metadata.confidenceLabel).toBe('low');
    expect(metadata.warnings).toContain('ocr_date_disagrees_with_event_time');
    expect(metadata.extractedText).toContain('Official document');
  });

  it('downgrades factuality when media extraction is low-confidence', () => {
    const factuality = (
      MemoryProcessor.prototype as unknown as {
        guardMediaFactuality(
          factuality: { label: string; confidence: number; rationale: string },
          metadata: Record<string, unknown>,
        ): { label: string; confidence: number; rationale: string };
      }
    ).guardMediaFactuality(
      { label: 'FACT', confidence: 0.95, rationale: 'Model said so' },
      {
        mediaExtraction: {
          confidence: 0.45,
          warnings: ['ocr_date_disagrees_with_event_time'],
        },
      },
    );

    expect(factuality.label).toBe('UNVERIFIED');
    expect(factuality.confidence).toBeLessThan(0.6);
    expect(factuality.rationale).toContain('ocr_date_disagrees_with_event_time');
  });
});
